/**
 * Moves response bodies from a worker back to main in scaling mode.
 *
 * A small body travels inline inside the queue message. A larger one is stored
 * in the binary-data store and replaced with a reference, so the size of a
 * response no longer bounds what the queue must hold.
 */

import { Logger } from '@n8n/backend-common';
import { EndpointsConfig } from '@n8n/config';
import { Service } from '@n8n/di';
import { jsonSizeExceeds } from '@n8n/utils/json/json-size-exceeds';
import { BinaryDataConfig, BinaryDataService, FileLocation } from 'n8n-core';
import { BINARY_ENCODING, jsonParse, OperationalError, UserError } from 'n8n-workflow';
import type {
	IBinaryData,
	IDataObject,
	IExecuteResponsePromiseData,
	IN8nHttpFullResponse,
} from 'n8n-workflow';
import { Readable } from 'node:stream';

const MIB = 1024 * 1024;

/** Sentinel key marking a base64-encoded Buffer body relayed inline through the queue. */
export const ENCODED_BUFFER_KEY = '__@N8nEncodedBuffer@__';

/**
 * Sentinel key recording an offloaded body's original form, so it can be restored.
 * It sits on the relayed response, beside `body`, never inside it:
 * - a body's content comes from the workflow
 * - the response envelope only from the relay
 * So only a reference the relay itself stored reads as offloaded.
 */
export const OFFLOADED_BODY_KIND_KEY = '__@N8nOffloadedBodyKind@__';

/** Modes storing where every instance can read. `default` keeps bytes in memory, `filesystem` on one host's disk. */
const SHARED_STORE_MODES: Array<BinaryDataConfig['mode']> = ['database', 's3', 'azure'];

/** What Express sets on a string body sent inline through `res.send`. */
const INLINE_STRING_CONTENT_TYPE = 'text/html; charset=utf-8';

/** What Express sets on a JSON body sent inline through `res.json`. */
const INLINE_JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

const NO_SHARED_STORE_GUIDANCE =
	'In scaling mode a response over this size is stored for the main instance to stream, which needs a binary-data store both share. Set N8N_DEFAULT_BINARY_DATA_MODE to database, s3 or azure, or raise N8N_WEBHOOK_RESPONSE_RELAY_SIZE_MAX.';

const NOT_OFFLOADABLE_GUIDANCE =
	'In scaling mode a response is relayed to the main instance through the queue, which limits how large it can be. Only a response body can be stored for the main instance to stream instead, so raise N8N_WEBHOOK_RESPONSE_RELAY_SIZE_MAX to relay a payload this large.';

/** Execution an offloaded body is stored for. */
export type RelayContext = { workflowId: string; executionId: string };

const OFFLOADED_BODY_KINDS = ['buffer', 'string', 'json'] as const;

type OffloadedBodyKind = (typeof OFFLOADED_BODY_KINDS)[number];

/** A body in any form the relay stores and restores. */
type OffloadedBodyContent = Buffer | string | IDataObject;

/**
 * A payload the relay can measure and offload.
 */
type OffloadablePayload = {
	kind: OffloadedBodyKind;
	exceeds: (maxBytes: number) => boolean;
	serialize: () => Buffer;
	inlineContentType?: string;
};

/** A reference to a stored body, tagged with the form to restore it to. */
type OffloadedBody = {
	binaryData: IBinaryData & { id: string };
	kind: OffloadedBodyKind;
};

/**
 * A full response that may carry the {@link OFFLOADED_BODY_KIND_KEY} marker.
 *
 * @remarks The marker is typed `unknown` because a relayed response is parsed
 * from the queue message, where nothing constrains what the key holds. Reading
 * it therefore goes through {@link isOffloadedBodyKind}.
 */
type OffloadMarkedResponse = IN8nHttpFullResponse &
	Partial<Record<typeof OFFLOADED_BODY_KIND_KEY, unknown>>;

/**
 * Carries a response body from a worker to main in scaling mode, inline inside
 * the queue message or through the binary-data store.
 */
@Service()
export class WebhookResponseRelay {
	constructor(
		private readonly logger: Logger,
		private readonly binaryDataService: BinaryDataService,
		private readonly binaryDataConfig: BinaryDataConfig,
		private readonly endpointsConfig: EndpointsConfig,
	) {
		this.logger = this.logger.scoped('scaling');
	}

	/**
	 * Prepares a worker's response to travel inside a queue message:
	 * - the body of a response over the size limit is stored and replaced with a reference
	 * - a Buffer body staying inline is base64-encoded
	 * - and any other body passes through.
	 *
	 * @param response Worker response. Mutated and returned.
	 * @returns The same `response`.
	 *
	 * @throws UserError When the response is over the limit and no store shared
	 * with main can hold its body, or when the part of the response that cannot
	 * be offloaded is over the limit on its own.
	 */
	async prepare(
		response: IExecuteResponsePromiseData,
		ctx: RelayContext,
	): Promise<IExecuteResponsePromiseData> {
		if (!isFullResponse(response)) {
			this.assertFitsInline(response);
			return response;
		}

		const { body, ...rest } = response;
		this.assertFitsInline(rest);

		const offloadable = asOffloadablePayload(body);

		if (!offloadable || !this.exceedsInline(response, offloadable)) {
			return encodeBufferBody(response);
		}

		if (!SHARED_STORE_MODES.includes(this.binaryDataConfig.mode)) {
			throw new UserError(this.tooLargeMessage(), { description: NO_SHARED_STORE_GUIDANCE });
		}

		await this.offload(response, offloadable, ctx);

		return response;
	}

	/**
	 * Replaces an offloaded body with its stored content.
	 * Any other response passes through.
	 *
	 * @param response Relayed response. Mutated and returned.
	 * @param reclaim Whether this caller is the sole reader of the response.
	 * A sole reader deletes the stored body once read, and a body that cannot
	 * be fetched fails the delivery it owns. Where the same relayed response
	 * reaches several readers, deleting would strand the others, and a fetch
	 * failure degrades to an empty body of the original form instead, never
	 * the reference itself.
	 * @returns The same `response`.
	 * @throws OperationalError When `reclaim` is set and the stored content cannot be fetched.
	 */
	async restoreOffloadedBody<T>(response: T, { reclaim }: { reclaim: boolean }): Promise<T> {
		if (!isFullResponse(response)) {
			return response;
		}

		const offloaded = asOffloadedBody(response);
		if (!offloaded) {
			return response;
		}

		try {
			const buffer = await this.binaryDataService.getAsBuffer(offloaded.binaryData);
			response.body = deserializeBody(buffer, offloaded.kind);
		} catch (error) {
			if (reclaim) {
				throw new OperationalError('The stored webhook response body could not be read', {
					cause: error,
				});
			}
			this.logger.warn('Failed to restore an offloaded webhook response body', { error });
			response.body = emptyBodyOf(offloaded.kind);
			clearOffloadMarker(response);
			return response;
		}

		clearOffloadMarker(response);

		if (reclaim) {
			await this.deleteStoredBody(offloaded.binaryData.id);
		}

		return response;
	}

	/**
	 * Reclaims the storage of an offloaded body.
	 * A no-op for any other body.
	 *
	 * @remarks Failures are logged rather than thrown: the response has already
	 * been delivered, and a body left behind is reclaimed by execution pruning
	 * (`database`) or by store lifecycle rules (object stores).
	 */
	async deleteOffloadedBody(response: IExecuteResponsePromiseData): Promise<void> {
		if (isFullResponse(response)) {
			const offloaded = asOffloadedBody(response);
			if (offloaded) {
				await this.deleteStoredBody(offloaded.binaryData.id);
			}
		}
	}

	private get maxInlineBytes(): number {
		return this.endpointsConfig.webhookResponseRelaySizeMax * MIB;
	}

	private tooLargeMessage(): string {
		const { webhookResponseRelaySizeMax } = this.endpointsConfig;
		return `The response is too large to be sent back from the worker (over ${webhookResponseRelaySizeMax} MiB)`;
	}

	/**
	 * Asserts that a payload with no offload path is small enough to travel
	 * inline inside a queue message.
	 *
	 * @throws UserError When the payload is over the limit.
	 *
	 * @remarks The size measured is the payload's own in the form it travels in,
	 * not that of the queue message carrying it, and JSON content is measured by a
	 * lower bound. Both approximations under-report, so a payload is never
	 * rejected for a size it does not have.
	 */
	private assertFitsInline(payload: unknown): void {
		if (asOffloadablePayload(payload)?.exceeds(this.maxInlineBytes)) {
			throw new UserError(this.tooLargeMessage(), { description: NOT_OFFLOADABLE_GUIDANCE });
		}
	}

	/**
	 * Whether `response` is too large to travel inline inside a queue message.
	 *
	 * @remarks Measured twice, because neither measure bounds the other: the body
	 * by the form it travels in, which counts a string in bytes and a Buffer
	 * base64-encoded, and the whole response as JSON, which counts the headers but
	 * a string in UTF-16 code units and a Buffer as one byte each.
	 */
	private exceedsInline(response: IN8nHttpFullResponse, body: OffloadablePayload): boolean {
		return body.exceeds(this.maxInlineBytes) || jsonSizeExceeds(response, this.maxInlineBytes);
	}

	/**
	 * @throws When the store does not persist the body, leaving `response` untouched.
	 */
	private async offload(
		response: OffloadMarkedResponse,
		{ kind, serialize, inlineContentType }: OffloadablePayload,
		{ workflowId, executionId }: RelayContext,
	): Promise<void> {
		const existingContentType = contentTypeOf(response.headers);
		const contentType = existingContentType ?? inlineContentType;

		// Stored under the execution so that pruning reclaims a body no reader
		// deleted. `database` also requires it: a custom location needs a source
		// type that store does not register.
		const location = FileLocation.ofExecution(workflowId, executionId);

		const stored = await this.binaryDataService.store(location, serialize(), {
			data: '',
			mimeType: contentType ?? 'application/octet-stream',
			fileName: 'webhook-response',
		});

		if (!stored.id) {
			throw new OperationalError('Binary-data store did not persist the webhook response body');
		}

		// Main streams a stored body instead of sending it through `res.json` or
		// `res.send`, so the `content-type` Express would have set has to travel
		// with it, keeping a response's headers independent of its size.
		if (contentType !== undefined && existingContentType === undefined) {
			response.headers ??= {};
			response.headers['content-type'] = contentType;
		}

		response.body = { binaryData: stored };
		response[OFFLOADED_BODY_KIND_KEY] = kind;
	}

	private async deleteStoredBody(binaryDataId: string): Promise<void> {
		try {
			await this.binaryDataService.deleteManyByBinaryDataId([binaryDataId]);
		} catch (error) {
			this.logger.warn('Failed to delete an offloaded webhook response body', {
				binaryDataId,
				error,
			});
		}
	}
}

/**
 * Reverses the inline base64 envelope on main, restoring a Buffer body. Every
 * other body passes through, an offloaded one included: main streams that from
 * storage rather than materializing it.
 *
 * @param response Relayed response. Mutated and returned.
 * @returns The same `response`.
 */
export function decodeRelayedWebhookResponse<T>(response: T): T {
	if (!isFullResponse(response)) {
		return response;
	}

	const encoded = encodedBufferIn(response.body);
	if (encoded !== undefined) {
		response.body = Buffer.from(encoded, BINARY_ENCODING);
	}

	return response;
}

/**
 * Bytes `byteLength` bytes occupy once base64-encoded, the form a Buffer takes to
 * travel inline. Excludes the envelope around it, keeping this a lower bound.
 */
function base64Size(byteLength: number): number {
	return Math.ceil(byteLength / 3) * 4;
}

function encodeBufferBody(response: IN8nHttpFullResponse): IN8nHttpFullResponse {
	if (Buffer.isBuffer(response.body)) {
		response.body = { [ENCODED_BUFFER_KEY]: response.body.toString(BINARY_ENCODING) };
	}

	return response;
}

/**
 * Views a payload as one the relay can measure and offload, or `undefined` for a
 * payload it does neither to: a stream, an existing binary-data reference,
 * `null`.
 *
 * Sizing never copies the payload, and serializing is left to the caller, so
 * JSON is stringified only once its size is known to require it.
 */
function asOffloadablePayload(payload: unknown): OffloadablePayload | undefined {
	if (Buffer.isBuffer(payload)) {
		return {
			kind: 'buffer',
			exceeds: (maxBytes) => base64Size(payload.length) > maxBytes,
			serialize: () => payload,
		};
	}

	if (typeof payload === 'string') {
		return {
			kind: 'string',
			exceeds: (maxBytes) => Buffer.byteLength(payload) > maxBytes,
			serialize: () => Buffer.from(payload),
			inlineContentType: INLINE_STRING_CONTENT_TYPE,
		};
	}

	if (isPlainJson(payload)) {
		return {
			kind: 'json',
			exceeds: (maxBytes) => jsonSizeExceeds(payload, maxBytes),
			serialize: () => Buffer.from(JSON.stringify(payload)),
			inlineContentType: INLINE_JSON_CONTENT_TYPE,
		};
	}

	return undefined;
}

/**
 * Restores stored content to the form {@link asOffloadablePayload} captured.
 *
 * @remarks The return type excludes `undefined`, unlike a body's, so that a form
 * left uncovered here is a compile error rather than a body silently missing.
 */
function deserializeBody(buffer: Buffer, kind: OffloadedBodyKind): OffloadedBodyContent {
	switch (kind) {
		case 'buffer':
			return buffer;
		case 'string':
			return buffer.toString('utf8');
		case 'json':
			return jsonParse<IDataObject>(buffer.toString('utf8'));
	}
}

/** An empty body of the given form, substituted when stored content cannot be fetched. */
function emptyBodyOf(kind: OffloadedBodyKind): OffloadedBodyContent {
	switch (kind) {
		case 'buffer':
			return Buffer.alloc(0);
		case 'string':
			return '';
		case 'json':
			return {};
	}
}

/**
 * Narrows a response's body to a reference the relay itself stored.
 * A binary-data reference without it is a
 * genuine binary response, never restored and never deleted here — wherever
 * the reference sits, only the marker written by {@link WebhookResponseRelay}
 * makes it an offloaded body.
 */
function asOffloadedBody(response: IN8nHttpFullResponse): OffloadedBody | undefined {
	if (!isBinaryDataReference(response.body)) {
		return undefined;
	}

	const marked: OffloadMarkedResponse = response;
	const kind = marked[OFFLOADED_BODY_KIND_KEY];
	if (isOffloadedBodyKind(kind)) {
		return {
			binaryData: response.body.binaryData,
			kind,
		};
	}

	return undefined;
}

/** Whether a relayed marker holds a form this relay can restore. */
function isOffloadedBodyKind(value: unknown): value is OffloadedBodyKind {
	return typeof value === 'string' && OFFLOADED_BODY_KINDS.some((kind) => kind === value);
}

/** Removes the offload marker, returning a restored response to its plain form. */
function clearOffloadMarker(response: IN8nHttpFullResponse): void {
	const marked: OffloadMarkedResponse = response;
	delete marked[OFFLOADED_BODY_KIND_KEY];
}

function isFullResponse(response: unknown): response is IN8nHttpFullResponse {
	return typeof response === 'object' && response !== null && 'body' in response;
}

/** The base64 payload of an {@link ENCODED_BUFFER_KEY} envelope, if the body is one. */
function encodedBufferIn(body: IN8nHttpFullResponse['body']): string | undefined {
	if (typeof body !== 'object' || body === null || !(ENCODED_BUFFER_KEY in body)) {
		return undefined;
	}

	const encoded = body[ENCODED_BUFFER_KEY];
	return typeof encoded === 'string' ? encoded : undefined;
}

function isPlainJson(payload: unknown): payload is IDataObject {
	return (
		typeof payload === 'object' &&
		payload !== null &&
		!Buffer.isBuffer(payload) &&
		!(payload instanceof Readable) &&
		!isBinaryDataReference(payload)
	);
}

function isBinaryDataReference(
	body: unknown,
): body is IDataObject & { binaryData: IBinaryData & { id: string } } {
	if (typeof body !== 'object' || body === null || !('binaryData' in body)) {
		return false;
	}

	const { binaryData } = body;
	return (
		typeof binaryData === 'object' &&
		binaryData !== null &&
		'id' in binaryData &&
		typeof binaryData.id === 'string'
	);
}

function contentTypeOf(headers: IN8nHttpFullResponse['headers']): string | undefined {
	const entry = Object.entries(headers ?? {}).find(
		([name]) => name.toLowerCase() === 'content-type',
	);

	return typeof entry?.[1] === 'string' ? entry[1] : undefined;
}

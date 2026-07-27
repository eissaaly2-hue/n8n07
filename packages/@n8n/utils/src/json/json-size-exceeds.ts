/** A value whose members are measured separately from the value itself. */
type JsonContainer = Record<string, unknown> | unknown[];

const QUOTES_SIZE = 2;
const COLON_SIZE = 1;
const COMMA_SIZE = 1;
const SIGN_SIZE = 1;
const SHORTEST_NUMBER_SIZE = 1; // "0"
const SHORTEST_KEYWORD_SIZE = 4; // "null", "true"
const EMPTY_CONTAINER_SIZE = 2; // "{}", "[]"
const EXPONENTIAL_NOTATION_THRESHOLD = 1e21;

/**
 * Whether `value` occupies more than `maxBytes` once serialized to JSON, without
 * serializing it.
 *
 * The measure is a lower bound, so a value is never reported as exceeding a size
 * it does not have. It under-counts multi-byte expansion and escaping, a number
 * by one digit, a value carrying a `toJSON` method (measured as its own
 * properties instead), and a reference reached twice (measured once, which is
 * also why a cyclic value is answered rather than throwing).
 *
 * Computation is linear in the values visited, and every value costs at least
 * one byte, so about `maxBytes` of content is visited at most, whatever the size
 * of `value`. Memory is linear in the containers visited, never in the
 * primitives they hold.
 */
export function jsonSizeExceeds(value: unknown, maxBytes: number): boolean {
	if (!isContainer(value)) {
		return minSerializedSize(value) > maxBytes;
	}

	const measured = new WeakSet<object>();
	const containers: JsonContainer[] = [value];
	let lowerBound = 0;

	for (let container = containers.pop(); container !== undefined; container = containers.pop()) {
		if (measured.has(container)) {
			continue;
		}
		measured.add(container);

		lowerBound += measureMembers(container, containers, maxBytes - lowerBound);

		if (lowerBound > maxBytes) {
			return true;
		}
	}

	return false;
}

/**
 * Lower bound of the bytes `container`'s own members occupy, the members of the
 * containers among them being appended to `nested` instead.
 *
 * @param budget Bytes left before the limit. Measuring stops above it.
 */
function measureMembers(container: JsonContainer, nested: JsonContainer[], budget: number): number {
	if (Buffer.isBuffer(container)) {
		// A byte occupies at least a digit and a separator, and walking the indices
		// would allocate a key per byte.
		return container.length;
	}

	if (Array.isArray(container)) {
		return measureElements(container, nested, budget);
	}

	return measureEntries(container, nested, budget);
}

function measureElements(elements: unknown[], nested: JsonContainer[], budget: number): number {
	let size = 0;
	let counted = 0;

	for (const element of elements) {
		size += minSerializedSize(element) + (counted === 0 ? 0 : COMMA_SIZE);
		counted += 1;

		if (isContainer(element)) {
			nested.push(element);
		}

		if (size > budget) {
			break;
		}
	}

	return size;
}

function measureEntries(
	entries: Record<string, unknown>,
	nested: JsonContainer[],
	budget: number,
): number {
	let size = 0;
	let counted = 0;

	for (const key in entries) {
		if (!Object.hasOwn(entries, key)) {
			continue; // inherited properties are not serialized
		}

		const value = entries[key];

		if (isDroppedFromObjects(value)) {
			continue;
		}

		size +=
			QUOTES_SIZE +
			key.length +
			COLON_SIZE +
			minSerializedSize(value) +
			(counted === 0 ? 0 : COMMA_SIZE);
		counted += 1;

		if (isContainer(value)) {
			nested.push(value);
		}

		if (size > budget) {
			break;
		}
	}

	return size;
}

/**
 * Lower bound of the bytes `value` occupies once serialized, a container
 * counting as its delimiters only.
 *
 * A value JSON cannot represent counts as `null`, its serialization in array
 * position. In object position the whole entry disappears instead, see
 * {@link isDroppedFromObjects}.
 */
function minSerializedSize(value: unknown): number {
	switch (typeof value) {
		case 'string':
			return value.length + QUOTES_SIZE;
		case 'number':
			return minNumberSize(value);
		case 'boolean':
			return SHORTEST_KEYWORD_SIZE;
		case 'object':
			return value === null ? SHORTEST_KEYWORD_SIZE : EMPTY_CONTAINER_SIZE;
		default:
			return SHORTEST_KEYWORD_SIZE;
	}
}

/** Lower bound of the bytes `value` occupies once serialized as a JSON number. */
function minNumberSize(value: number): number {
	if (!Number.isFinite(value)) {
		return SHORTEST_KEYWORD_SIZE; // serializes as null
	}

	const magnitude = Math.abs(value);
	const sign = value < 0 ? SIGN_SIZE : 0;

	// Exponential notation above the threshold, and no certain digit count below one.
	if (magnitude < 1 || magnitude >= EXPONENTIAL_NOTATION_THRESHOLD) {
		return sign + SHORTEST_NUMBER_SIZE;
	}

	// One digit fewer than the magnitude implies, so that a rounding error in
	// log10 cannot turn this into an over-estimate.
	return sign + Math.max(SHORTEST_NUMBER_SIZE, Math.floor(Math.log10(magnitude)));
}

/** Whether serializing an object drops the entry holding `value`, key included. */
function isDroppedFromObjects(value: unknown): boolean {
	const type = typeof value;
	return type === 'undefined' || type === 'function' || type === 'symbol';
}

function isContainer(value: unknown): value is JsonContainer {
	return typeof value === 'object' && value !== null;
}

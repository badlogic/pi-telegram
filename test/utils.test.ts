import { describe, it } from "node:test";
import assert from "node:assert";
import { chunkParagraphs, formatTokens, sanitizeFileName, guessExtensionFromMime, isImageMimeType } from "../src/utils.ts";

describe("chunkParagraphs", () => {
	it("returns a single element for short text", () => {
		const result = chunkParagraphs("hello world");
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0], "hello world");
	});

	it("splits long text into chunks each <= MAX_MESSAGE_LENGTH (4096)", () => {
		const longText = "a".repeat(5000);
		const result = chunkParagraphs(longText);
		for (const chunk of result) {
			assert.ok(chunk.length <= 4096, `chunk length ${chunk.length} exceeds 4096`);
		}
		// There should be more than 1 chunk
		assert.ok(result.length > 1, "expected more than 1 chunk for 5000-character input");
	});

	it("splits on paragraph boundaries (not mid-word)", () => {
		// Build text with paragraph separators, where each paragraph is short
		// but many paragraphs exceed the limit
		const paragraph = "The quick brown fox jumps over the lazy dog. ".repeat(80); // ~4000 chars each
		const text = [paragraph, paragraph].join("\n\n");
		const result = chunkParagraphs(text);

		// Each chunk should be at most 4096
		for (const chunk of result) {
			assert.ok(chunk.length <= 4096, `chunk length ${chunk.length} exceeds 4096`);
		}

		// Two 4000-char paragraphs can't fit in one 4096-char message,
		// so we should get 2 chunks
		assert.strictEqual(result.length, 2);
	});

	it("handles empty string", () => {
		const result = chunkParagraphs("");
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0], "");
	});

	it("handles text with \\r\\n line endings", () => {
		// Short text triggers early return before normalization; long text gets normalized
		const shortText = "line1\r\n\r\nline2";
		const shortResult = chunkParagraphs(shortText);
		assert.strictEqual(shortResult.length, 1);

		// For long text with \r\n, normalization kicks in
		const longParagraph = "The quick brown fox jumps over the lazy dog. ".repeat(100); // ~4500 chars
		const longText = [longParagraph, "Another paragraph."].join("\r\n\r\n");
		const result = chunkParagraphs(longText);
		for (const chunk of result) {
			assert.ok(chunk.length <= 4096);
			// Normalized: \r\n should be replaced, so no \r\n sequences remain
			assert.ok(!chunk.includes("\r\n"));
		}
	});
});

describe("formatTokens", () => {
	it('formats 0 as "0"', () => {
		assert.strictEqual(formatTokens(0), "0");
	});

	it('formats 999 as "999"', () => {
		assert.strictEqual(formatTokens(999), "999");
	});

	it('formats 1500 as "1.5k"', () => {
		assert.strictEqual(formatTokens(1500), "1.5k");
	});

	it('formats 2500000 as "2.5M"', () => {
		assert.strictEqual(formatTokens(2500000), "2.5M");
	});

	it('formats 50000 as "50k"', () => {
		assert.strictEqual(formatTokens(50000), "50k");
	});

	it('formats 10000000 as "10M"', () => {
		assert.strictEqual(formatTokens(10000000), "10M");
	});
});

describe("sanitizeFileName", () => {
	it('replaces spaces and slashes with underscores', () => {
		assert.strictEqual(sanitizeFileName("a b/c"), "a_b_c");
	});

	it("preserves dots, dashes, and underscores", () => {
		assert.strictEqual(sanitizeFileName("my-file_v2.txt"), "my-file_v2.txt");
	});

	it("removes special characters", () => {
		assert.strictEqual(sanitizeFileName("hello@world!test#"), "hello_world_test_");
	});

	it("handles empty string", () => {
		assert.strictEqual(sanitizeFileName(""), "");
	});
});

describe("guessExtensionFromMime", () => {
	it('maps "image/jpeg" to ".jpg"', () => {
		assert.strictEqual(guessExtensionFromMime("image/jpeg", ".bin"), ".jpg");
	});

	it('maps "image/png" to ".png"', () => {
		assert.strictEqual(guessExtensionFromMime("image/png", ".bin"), ".png");
	});

	it("returns fallback for unknown mime type", () => {
		assert.strictEqual(guessExtensionFromMime("application/octet-stream", ".bin"), ".bin");
	});

	it("returns fallback for undefined mime type", () => {
		assert.strictEqual(guessExtensionFromMime(undefined, ".bin"), ".bin");
	});
});

describe("isImageMimeType", () => {
	it("returns true for image/ mime types", () => {
		assert.strictEqual(isImageMimeType("image/jpeg"), true);
		assert.strictEqual(isImageMimeType("image/png"), true);
		assert.strictEqual(isImageMimeType("image/gif"), true);
	});

	it("returns false for non-image mime types", () => {
		assert.strictEqual(isImageMimeType("video/mp4"), false);
		assert.strictEqual(isImageMimeType("application/pdf"), false);
	});

	it("returns false for undefined", () => {
		assert.strictEqual(isImageMimeType(undefined), false);
	});
});

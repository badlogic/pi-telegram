// Telegram HTML formatting support for AI assistant replies

import { marked } from "marked";

function escapeTelegramHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Telegram rejects nested identical tags (e.g. <b><b>x</b></b>). Strip inner bold
// before re-wrapping content that is already emphasized as a whole (headings, cells).
function stripBold(text: string): string {
	return text.replace(/<\/?b>/g, "");
}

/**
 * Convert markdown to Telegram-supported HTML subset.
 * Supported tags: <b> <i> <u> <s> <a> <code> <pre> <blockquote> <tg-spoiler>
 */
export function markdownToTelegramHtml(markdown: string): string {
	let listContext: { ordered: boolean; index: number } | null = null;
	
	const renderer = {
		text(this: any, token: { text: string; tokens?: any[] }): string {
			// Block-level text tokens carry inline children (bold, code, etc.).
			// Parse them so emphasis inside lists and cells is preserved.
			return token.tokens ? this.parser.parseInline(token.tokens) : escapeTelegramHtml(token.text);
		},
		html(token: { text: string }): string {
			return escapeTelegramHtml(token.text);
		},
		strong(this: any, token: { tokens: any[] }): string {
			const content = this.parser.parseInline(token.tokens);
			return `<b>${content}</b>`;
		},
		em(this: any, token: { tokens: any[] }): string {
			const content = this.parser.parseInline(token.tokens);
			return `<i>${content}</i>`;
		},
		link(this: any, token: { href: string; tokens: any[] }): string {
			const content = this.parser.parseInline(token.tokens);
			return `<a href="${token.href}">${content}</a>`;
		},
		paragraph(this: any, token: { tokens: any[] }): string {
			// Telegram HTML does not support <p>; emit inline content with paragraph spacing
			return this.parser.parseInline(token.tokens) + '\n\n';
		},
		heading(this: any, token: { tokens: any[] }): string {
			const content = stripBold(this.parser.parseInline(token.tokens));
			return `<b>${content}</b>\n\n`;
		},
		list(this: any, token: { ordered: boolean; items: any[] }): string {
			listContext = { ordered: token.ordered, index: 0 };
			const items = token.items.map((item: any) => {
				const prefix = listContext!.ordered ? `${++listContext!.index}. ` : '• ';
				// Parse inline tokens so bold/italic/code inside list items render.
				return prefix + this.parser.parseInline(item.tokens);
			});
			listContext = null;
			return items.join('\n') + '\n\n';
		},
		// Telegram has no table primitive, so flatten into readable labeled blocks.
		// Each row becomes a titled block keyed by the first column, with remaining
		// columns listed under their header. This survives narrow screens and emoji
		// better than space-padded monospace alignment.
		table(this: any, token: { header: any[]; rows: any[][] }): string {
			const renderCell = (cell: any): string => this.parser.parseInline(cell.tokens);
			const headers = token.header.map(renderCell);
			const blocks = token.rows.map((row: any[]) => {
				const cells = row.map(renderCell);
				if (cells.length <= 2) {
					return cells.length === 2
						? `• <b>${stripBold(cells[0])}</b>: ${cells[1]}`
						: `• ${cells[0]}`;
				}
				const title = stripBold(cells[0]);
				const lines = cells.slice(1).map((value, idx) => `• ${stripBold(headers[idx + 1])}: ${value}`);
				return `<b>${title}</b>\n` + lines.join('\n');
			});
			return blocks.join('\n\n') + '\n\n';
		},
	};
	
	marked.use({ renderer });
	const html = marked.parse(markdown) as string;
	
	// Collapse the extra blank lines introduced by block separators and trim edges
	return html.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Split HTML into <=maxLength chunks while preserving tag balance.
 * Open tags are closed at chunk boundaries and reopened in the next chunk.
 */
export function chunkTelegramHtml(html: string, maxLength = 4096): string[] {
	if (html.length <= maxLength) {
		return [html];
	}
	
	const chunks: string[] = [];
	const tagStack: Array<{ name: string; fullTag: string }> = [];
	let currentChunk = '';
	let i = 0;
	
	while (i < html.length) {
		// Check if we need to split before adding more content
		// Leave room for closing tags (estimate 50 chars per tag)
		const closingTagsLength = tagStack.reduce((sum, tag) => sum + tag.name.length + 3, 0); // </name>
		if (currentChunk.length + closingTagsLength >= maxLength) {
			// Close all open tags
			for (let j = tagStack.length - 1; j >= 0; j--) {
				currentChunk += `</${tagStack[j].name}>`;
			}
			chunks.push(currentChunk);
			
			// Start new chunk by reopening tags
			currentChunk = tagStack.map(tag => tag.fullTag).join('');
		}
		
		// Parse next token
		if (html[i] === '<') {
			// Find end of tag
			const tagEnd = html.indexOf('>', i);
			if (tagEnd === -1) break; // Malformed HTML
			
			const tag = html.slice(i, tagEnd + 1);
			currentChunk += tag;
			
			// Determine tag type
			if (tag.startsWith('</')) {
				// Closing tag
				const tagName = tag.slice(2, -1).trim();
				// Pop matching opening tag from stack
				for (let j = tagStack.length - 1; j >= 0; j--) {
					if (tagStack[j].name === tagName) {
						tagStack.splice(j, 1);
						break;
					}
				}
			} else if (!tag.endsWith('/>') && !tag.startsWith('<!')) {
				// Opening tag (not self-closing, not comment)
				const spaceIndex = tag.indexOf(' ');
				const closeIndex = tag.indexOf('>');
				const tagName = tag.slice(1, spaceIndex > 0 && spaceIndex < closeIndex ? spaceIndex : closeIndex).trim();
				tagStack.push({ name: tagName, fullTag: tag });
			}
			// Self-closing or comments are not tracked
			
			i = tagEnd + 1;
		} else {
			// Regular text content
			currentChunk += html[i];
			i++;
		}
	}
	
	// Add final chunk
	if (currentChunk.length > 0) {
		chunks.push(currentChunk);
	}
	
	return chunks;
}

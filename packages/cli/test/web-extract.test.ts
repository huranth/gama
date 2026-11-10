import { describe, expect, it } from "vitest";
import {
	removeBoilerplate,
	removeElement,
	stripTags,
} from "../src/core/tools/web/extract/boilerplate.ts";
import { decodeHtmlEntities } from "../src/core/tools/web/extract/entities.ts";
import { extractMarkdownFrontmatter } from "../src/core/tools/web/extract/frontmatter.ts";
import { extractReadableHtml } from "../src/core/tools/web/extract/readability.ts";
import {
	normalizeText,
	truncateParagraphs,
	truncateText,
} from "../src/core/tools/web/extract/text.ts";

const articlePage = `<!doctype html>
<html>
<head>
	<title>Ship faster &amp; safer</title>
	<meta name="description" content="How to ship code without fear">
</head>
<body>
	<nav><a href="/home">Home</a> <a href="/docs">Docs</a></nav>
	<article>
		<h1>Ship faster</h1>
		<p>Small changes are easier to review &amp; revert.</p>
		<p>Read the <a href="https://example.com/guide">guide</a> first.</p>
		<img alt="pipeline" src="https://example.com/pipeline.png">
		<aside>Sponsored links</aside>
	</article>
	<footer>Copyright 2024</footer>
	<script>track("pageview")</script>
</body>
</html>`;

const docsPage = `<!doctype html>
<html>
<head><title>API reference</title></head>
<body>
	<div class="sidebar">Install / Upgrade / Uninstall</div>
	<main>
		<h1>CLI reference</h1>
		<p>Run <code>gama init</code> to start a project.</p>
		<ul><li>init</li><li>build</li><li>deploy</li></ul>
	</main>
	<footer>Need help? Contact support</footer>
</body>
</html>`;

const codeHeavyPage = `<!doctype html>
<html>
<head><title>Snippets</title></head>
<body>
	<article>
		<h1>Usage</h1>
		<p>Wrap nodes with <code>&lt;div&gt;</code> tags.</p>
		<pre><code class="language-ts">const items = [
	"a",
	"b",
];
if (items.length &gt; 1) { boom(); }</code></pre>
		<p>Output shown above.</p>
	</article>
</body>
</html>`;

const entitySoup = `<!doctype html>
<html>
<head><title>Quotes &amp; dashes</title></head>
<body>
	<article>
		<p>Tom &amp; Jerry &lt;3 &quot;cheese&quot; &#39;bites&#39; &#x27;deeply&#x27;</p>
		<p>Wait &hellip; &mdash; and &nbsp; &copy; 2024 &unknown; stays</p>
	</article>
</body>
</html>`;

const nestedListPage = `<!doctype html>
<html>
<head><title>Checklist</title></head>
<body>
	<article>
		<h1>Setup</h1>
		<ul>
			<li>Install
				<ul><li>Node</li><li>Git</li></ul>
			</li>
			<li>Configure</li>
		</ul>
		<p>Done.</p>
	</article>
</body>
</html>`;

const untitledPage = `<html>
<body>
	<main><p>No title here, just body text worth reading.</p></main>
</body>
</html>`;

const boilerplateOnlyPage = `<html>
<head><title>Nothing here</title><style>body { color: red; }</style></head>
<body>
	<nav><a href="/a">A</a><a href="/b">B</a><a href="/c">C</a></nav>
	<footer>footer footer footer footer footer</footer>
</body>
</html>`;

describe("entity decoding", () => {
	it("decodes named entities and leaves unknown ones literal", () => {
		const decoded = decodeHtmlEntities("&amp; &lt; &gt; &quot; &hellip; &x;");

		expect(decoded).toBe(`& < > " ... &x;`);
	});

	it("decodes decimal and hex code points, keeps invalid ones", () => {
		expect(decodeHtmlEntities("&#39; &#x27; &#65;")).toBe("' ' A");
		expect(decodeHtmlEntities("&#FFFFFFFF; &#xZZ;")).toBe("&#FFFFFFFF; &#xZZ;");
	});
});

describe("text helpers", () => {
	it("normalizes whitespace and collapses newlines", () => {
		const text = normalizeText("  a\t\tb  \n\n\n  c  \r\n  d ");

		expect(text).toBe("a b\nc\nd");
	});

	it("keeps list indentation", () => {
		const text = normalizeText("top\n    * nested item");

		expect(text).toBe("top\n    * nested item");
	});

	it("truncates on a line boundary with a marker", () => {
		const text = "first paragraph\nsecond paragraph";
		const cut = truncateText(text, 20);

		expect(cut.truncated).toBe(true);
		expect(cut.text.startsWith("first paragraph")).toBe(true);
		expect(cut.text).toContain("[Content truncated - showing");
		expect(cut.text).not.toContain("—");
	});

	it("closes an open code fence when cutting inside it", () => {
		const text = "intro\n```js\nline1\nline2\n```";
		const cut = truncateText(text, 20);

		expect(cut.text).toContain("[code block truncated]");
		expect(cut.text.match(/```/g)?.length).toBe(2);
	});

	it("leaves short text untouched", () => {
		expect(truncateText("tiny", 10)).toEqual({ text: "tiny", truncated: false });
	});
});

describe("boilerplate removal", () => {
	it("strips all tags", () => {
		expect(stripTags("<p>a<br>b</p>")).toBe(" a b ");
	});

	it("treats the replacement as literal text", () => {
		expect(stripTags("<p>a</p>", "$&")).toBe("$&a$&");
	});

	it("removes same-tag elements by nesting depth", () => {
		const raw = "<div><nav>outer<nav>inner</nav>tail</nav><p>keep</p></div>";

		expect(removeElement(raw, "nav")).toBe("<div>\n<p>keep</p></div>");
	});

	it("keeps indexes aligned after non-ascii lowercasing", () => {
		const raw = "<p>İstanbul</p><nav>hidden</nav><p>keep</p>";

		expect(removeElement(raw, "nav")).toBe("<p>İstanbul</p>\n<p>keep</p>");
	});

	it("removes a paired element", () => {
		expect(removeElement("<p>a<script>bad()</script>b</p>", "script")).toBe("<p>a\nb</p>");
	});

	it("drops boilerplate elements but keeps body text", () => {
		const cleaned = removeBoilerplate(
			`<style>.x{}</style><nav>nav</nav><p>keep me</p><form><input></form>`,
		);

		expect(cleaned).toContain("keep me");
		expect(cleaned).not.toContain("nav");
		expect(cleaned).not.toContain(".x{}");
	});

	it("survives an unclosed script without losing the page", () => {
		const raw = `<p>real content that matters a lot</p><script>swallow("everything`;
		const cleaned = removeBoilerplate(raw);

		expect(cleaned).toContain("real content that matters a lot");
		expect(cleaned).not.toContain("swallow");
	});

	it("survives an unclosed style tag too", () => {
		const raw = `<p>visible content stays here</p><style>.x{color:red}`;
		const cleaned = removeBoilerplate(raw);

		expect(cleaned).toContain("visible content stays here");
		expect(cleaned).not.toContain("color:red");
	});
});

describe("frontmatter splitting", () => {
	it("treats a doc without frontmatter as plain body", () => {
		const doc = extractMarkdownFrontmatter("# Just body\n\nText &amp; more");

		expect(doc.title).toBeUndefined();
		expect(doc.text).toContain("# Just body");
		expect(doc.text).toContain("Text & more");
	});

	it("reads quoted and bare values", () => {
		const doc = extractMarkdownFrontmatter(
			"---\ntitle: 'Single Quoted'\ndescription: Bare value here\n---\nBody",
		);

		expect(doc.title).toBe("Single Quoted");
		expect(doc.description).toBe("Bare value here");
	});
});

describe("paragraph truncation", () => {
	it("cuts on a paragraph boundary", () => {
		const cut = truncateParagraphs("First para here\n\nSecond para here\n\nThird para here", 20);

		expect(cut.truncated).toBe(true);
		expect(cut.text.startsWith("First para here")).toBe(true);
		expect(cut.text).toContain("[Content truncated]");
	});

	it("falls back to a raw cut without boundaries", () => {
		const cut = truncateParagraphs("abcdefghij\n\nmore", 5);

		expect(cut.text.startsWith("abcde")).toBe(true);
		expect(cut.truncated).toBe(true);
	});
});

describe("unicode handling", () => {
	it("decodes cjk numeric entities", () => {
		expect(decodeHtmlEntities("&#x4e2d;&#25991;")).toBe("中文");
	});

	it("keeps cjk text through extraction", () => {
		const page =
			`<html><head><title>中文标题</title></head>
		<body><article><h1>中文内容</h1>` +
			`<p>这是关于数据库索引的中文文章。</p></article></body></html>`;
		const out = extractReadableHtml(page, 20_000);

		expect(out.title).toBe("中文标题");
		expect(out.text).toContain("这是关于数据库索引的中文文章");
	});

	it("truncates cjk text with the marker", () => {
		const cut = truncateText("汉".repeat(500), 100);

		expect(cut.truncated).toBe(true);
		expect(cut.text).toContain("100 of 500");
		expect(cut.text.startsWith("汉".repeat(100))).toBe(true);
	});
});

describe("link and image policy", () => {
	const page = `<!doctype html><html><head><title>T</title></head><body><article>
		<h1>T</h1><p>Body text with a <a href="https://example.com/guide">guide</a> link.</p>
		<p><img src="https://img.shields.io/badge/build-pass-green" alt="build"></p>
		<p><img src="https://example.com/photo.png" alt="photo"></p>
	</article></body></html>`;

	it("renders links the same at any requested size", () => {
		const small = extractReadableHtml(page, 1_000);
		const large = extractReadableHtml(page, 50_000);

		expect(small.text).toContain("[guide](https://example.com/guide)");
		expect(large.text).toContain("[guide](https://example.com/guide)");
	});

	it("drops badge rows but keeps content images", () => {
		const out = extractReadableHtml(page, 50_000);

		expect(out.text).not.toContain("shields.io");
		expect(out.text).toContain("![photo](https://example.com/photo.png)");
	});
});

describe("readability extraction", () => {
	it("extracts the article with title, headings, links and images", () => {
		const out = extractReadableHtml(articlePage, 20_000);

		expect(out.title).toBe("Ship faster & safer");
		expect(out.description).toBe("How to ship code without fear");
		expect(out.text).toContain("# Ship faster");
		expect(out.text).toContain("[guide](https://example.com/guide)");
		expect(out.text).toContain("![pipeline](https://example.com/pipeline.png)");
		expect(out.text).not.toContain("Sponsored links");
		expect(out.text).not.toContain("Copyright 2024");
		expect(out.text).not.toContain("Navigation");
		expect(out.truncated).toBe(false);
	});

	it("drops wiki infobox, template, and caption noise", () => {
		const wiki = `<html>
<head><title>Capybara</title></head>
<body>
	<div id="mw-content-text">
		<table class="infobox biota"><tr><td>{{cite iucn |author=Reid, F. |year=2016}}</td></tr></table>
		<div class="mw-parser-output">
			<h1>Capybara</h1>
			<span data-mw='{"parts":[{"template":{"params":{"status_ref":{"wt":"{{cite iucn}}"}}}}]}'></span>
			<p>The capybara is the largest living rodent.</p>
			<p>![Refer to caption](//upload.wikimedia.org/capybara.jpg)</p>
			<div class="metadata">Hidden maintenance text</div>
		</div>
	</div>
</body>
</html>`;

		const out = extractReadableHtml(wiki, 20_000);

		expect(out.text).toContain("The capybara is the largest living rodent.");
		expect(out.text).not.toContain("cite iucn");
		expect(out.text).not.toContain("Refer to caption");
		expect(out.text).not.toContain("Hidden maintenance text");
	});

	it("keeps generic metadata blocks on non-wiki pages", () => {
		const out = extractReadableHtml(
			`<html><body><div class="metadata">Visible notes</div></body></html>`,
			20_000,
		);

		expect(out.text).toContain("Visible notes");
	});

	it("keeps description values with > and the opposite quote", () => {
		const doubleQuoted = `<html><head>
			<meta name="description" content="He said 'hi' > bye">
		</head><body><p>Body</p></body></html>`;
		const singleQuoted = `<html><head>
			<meta name='description' content='She said "hi" > bye'>
		</head><body><p>Body</p></body></html>`;
		const property = `<html><head>
			<meta property='og:description' content='Tag > value'>
		</head><body><p>Body</p></body></html>`;

		expect(extractReadableHtml(doubleQuoted, 1_000).description).toBe("He said 'hi' > bye");
		expect(extractReadableHtml(singleQuoted, 1_000).description).toBe('She said "hi" > bye');
		expect(extractReadableHtml(property, 1_000).description).toBe("Tag > value");
	});

	it("picks main content on docs pages and drops the sidebar", () => {
		const out = extractReadableHtml(docsPage, 20_000);

		expect(out.title).toBe("API reference");
		expect(out.text).toContain("# CLI reference");
		expect(out.text).toContain("`gama init`");
		expect(out.text).toContain("* init");
		expect(out.text).not.toContain("Install / Upgrade / Uninstall");
		expect(out.text).not.toContain("Contact support");
	});

	it("keeps code blocks fenced with language and decoded entities", () => {
		const out = extractReadableHtml(codeHeavyPage, 20_000);

		expect(out.text).toContain("```ts");
		expect(out.text).toContain('const items = [\n\t"a",\n\t"b",\n];');
		expect(out.text).toContain("if (items.length > 1) { boom(); }");
		expect(out.text).toContain("`<div>`");
		expect(out.text).not.toContain("&gt;");
	});

	it("decodes an entity soup without breaking the text", () => {
		const out = extractReadableHtml(entitySoup, 20_000);

		expect(out.title).toBe("Quotes & dashes");
		expect(out.text).toContain(`Tom & Jerry <3 "cheese" 'bites' 'deeply'`);
		expect(out.text).toContain("Wait ... - and (c) 2024 &unknown; stays");
	});

	it("preserves nested lists as indented asterisk lines", () => {
		const out = extractReadableHtml(nestedListPage, 20_000);
		const lines = out.text.split("\n");

		expect(lines).toContain("* Install");
		expect(lines).toContain("  * Node");
		expect(lines).toContain("  * Git");
		expect(lines).toContain("* Configure");
	});

	it("returns no title when the page has none", () => {
		const out = extractReadableHtml(untitledPage, 20_000);

		expect(out.title).toBeUndefined();
		expect(out.text).toContain("No title here");
	});

	it("throws on a boilerplate-only page with no readable text", () => {
		expect(() => extractReadableHtml(boilerplateOnlyPage, 20_000)).toThrow("No text");
	});

	it("truncates huge pages within budget on a paragraph boundary", () => {
		const filler = Array.from(
			{ length: 200 },
			(_, i) => `<p>Paragraph number ${i} with plenty of text.</p>`,
		).join("\n");
		const huge = `<html><body><article><h1>Big</h1>${filler}</article></body></html>`;
		const out = extractReadableHtml(huge, 500);

		expect(out.truncated).toBe(true);
		expect(out.text.length).toBeLessThanOrEqual(500 + 80);
		expect(out.text).toContain("[Content truncated");
	});

	it("falls back to the whole page when no candidate exists", () => {
		const out = extractReadableHtml(
			"<html><body><p>Bare page without semantic containers.</p></body></html>",
			20_000,
		);

		expect(out.text).toContain("Bare page without semantic containers.");
	});

	it("honors an itemprop articleBody candidate", () => {
		const page = `<html><body>
			<div class="menu">Home</div>
			<div itemprop="articleBody"><p>Long article body content lives here and matters.</p></div>
		</body></html>`;
		const out = extractReadableHtml(page, 20_000);

		expect(out.text).toContain("Long article body content");
		expect(out.text).not.toContain("Home");
	});
});

describe("boilerplate edge cases (bug sweep)", () => {
	it("leaves no stray close tags when one script is unclosed", () => {
		const raw = `<p>keep</p><script>a</script><script>unclosed body`;
		const cleaned = removeBoilerplate(raw);

		expect(cleaned).toContain("keep");
		expect(cleaned).not.toContain("</script>");
		expect(cleaned).not.toContain("unclosed body");
	});

	it("removes nested scripts and strips their orphan close tag", () => {
		const cleaned = removeBoilerplate(
			"<div><script>SECRET_A<script>SECRET_B</script>tail</script><p>body</p></div>",
		);

		expect(cleaned).toContain("body");
		expect(cleaned).not.toContain("SECRET_A");
		expect(cleaned).not.toContain("SECRET_B");
		expect(cleaned).not.toContain("</script>");
	});

	it("hides content after an unterminated comment like a browser would", () => {
		const cleaned = removeBoilerplate("<p>visible</p><!-- draft <p>hidden secret text</p>");

		expect(cleaned).toContain("visible");
		expect(cleaned).not.toContain("hidden secret text");
	});

	it("keeps content after a comment opener inside raw script text", () => {
		const cleaned = removeBoilerplate('<script>var s = "<!--"</script><p>still here</p>');

		expect(cleaned).toContain("still here");
		expect(cleaned).not.toContain("var s");
	});

	it("keeps content after a comment opener inside an attribute", () => {
		const cleaned = removeBoilerplate('<div title="<!--">visible</div>');

		expect(cleaned).toContain("visible");
	});

	it("strips tags without quadratic scans on a sea of < characters", () => {
		const sea = "<".repeat(200_000);
		const started = Date.now();

		expect(stripTags(sea)).toBe(sea);
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	it("scans unclosed tag floods in linear time", () => {
		const raw = "<div ".repeat(24_000);
		const started = Date.now();

		try {
			extractReadableHtml(raw, 20_000);
		} catch {}

		expect(Date.now() - started).toBeLessThan(1_000);
	});

	it("scans malformed tag floods in linear time", () => {
		const raw = `<article><p>${"<div ".repeat(24_000)}</p><p>tail</p></article>`;
		const started = Date.now();
		const out = extractReadableHtml(raw, 20_000);

		expect(Date.now() - started).toBeLessThan(1_000);
		expect(out.text).toContain("tail");
	});

	it("drops unclosed nav floods in linear time", () => {
		const raw = `${"<nav>".repeat(40_000)}<p>tail</p>`;
		const started = Date.now();
		const cleaned = removeBoilerplate(raw);

		expect(Date.now() - started).toBeLessThan(2_000);
		expect(cleaned).toContain("tail");
	});

	it("drops a sea of unclosed script openers in linear time", () => {
		const raw = `<p>tail</p>${"<script".repeat(100_000)}`;
		const started = Date.now();
		const cleaned = removeBoilerplate(raw);

		expect(Date.now() - started).toBeLessThan(2_000);
		expect(cleaned).toContain("tail");
	});

	it("still removes paired elements and tolerate close-tag whitespace", () => {
		expect(removeElement("<p>a<script>bad()</script>b</p>", "script")).toBe("<p>a\nb</p>");
		expect(removeElement("<p>a<script>x</script >b</p>", "script")).toBe("<p>a\nb</p>");
	});
});

describe("numeric entity edge cases (bug sweep)", () => {
	it("maps surrogates, NUL and out-of-range code points to U+FFFD", () => {
		const decoded = decodeHtmlEntities("&#xD800; &#xDC00; &#0; &#x110000;");

		expect(decoded).toBe("\uFFFD \uFFFD \uFFFD \uFFFD");
		expect(() => encodeURIComponent(decoded)).not.toThrow();
	});

	it("keeps malformed digit runs literal and valid astral code points", () => {
		expect(decodeHtmlEntities("&#FFFFFFFF; &#xZZ;")).toBe("&#FFFFFFFF; &#xZZ;");
		expect(decodeHtmlEntities("&#128512;")).toBe("\u{1F600}");
	});

	it("never double-decodes escaped entities", () => {
		expect(decodeHtmlEntities("&amp;lt; &amp;#65; &amp;amp;")).toBe("&lt; &#65; &amp;");
	});
});

describe("extract attribute lookalikes (bug sweep)", () => {
	it("ignores data-href when picking a link target", () => {
		const page =
			`<html><body><article><p>Read the <a data-href="WRONG" href="https://good.example"` +
			`>guide</a> now.</p></article></body></html>`;
		const out = extractReadableHtml(page, 20_000);

		expect(out.text).toContain("[guide](https://good.example)");
		expect(out.text).not.toContain("WRONG");
	});

	it("ignores data-src when picking an image source", () => {
		const page =
			`<html><body><article><p>Hi there friend.</p><img alt="pic" data-src="WRONG" src="` +
			`https://good.example/i.png"></article></body></html>`;
		const out = extractReadableHtml(page, 20_000);

		expect(out.text).toContain("![pic](https://good.example/i.png)");
		expect(out.text).not.toContain("WRONG");
	});
});

describe("truncation edge cases (bug sweep)", () => {
	it("does not split a surrogate pair at the cut point", () => {
		const text = "𠀀".repeat(60); // Astral CJK
		const cut = truncateText(text, 21);

		expect(cut.truncated).toBe(true);
		expect(() => encodeURIComponent(cut.text)).not.toThrow();
		expect([...cut.text.slice(0, 20)]).toEqual(Array(10).fill("𠀀"));
	});

	it("does not split a surrogate pair on a raw paragraph cut", () => {
		const cut = truncateParagraphs(`${"𠀀".repeat(30)}\n\nmore`, 21);

		expect(() => encodeURIComponent(cut.text)).not.toThrow();
	});

	it("closes a fence left open by a paragraph cut", () => {
		const md = "para one\n\n```\ncode line\n\nstill code\n```\n\npara two";
		const cut = truncateParagraphs(md, 30);

		expect(cut.text.match(/```/g)?.length).toBe(2);
		expect(cut.text).toContain("[code block truncated]");
	});

	it("detects indented opening fences when closing a cut", () => {
		const cut = truncateText("intro\n  ```js\nsome code line\n  ```\nafter", 14);

		expect(cut.text.match(/```/g)?.length).toBe(2);
		expect(cut.text).toContain("[code block truncated]");
	});
});

describe("frontmatter edge cases (bug sweep)", () => {
	it("does not let an empty value swallow the next line", () => {
		const doc = extractMarkdownFrontmatter("---\ntitle:\ndate: 2024-01-01\n---\nBody here");

		expect(doc.title).toBeUndefined();
		expect(doc.text).toContain("Body here");
	});

	it("does not treat ---- inside frontmatter as the closing fence", () => {
		const doc = extractMarkdownFrontmatter("---\ntitle: Real\n----\nBody");

		expect(doc.text).toContain("Body");
		expect(doc.text).not.toMatch(/^-\n/m);
	});

	it("reads values from CRLF frontmatter", () => {
		const doc = extractMarkdownFrontmatter(
			"---\r\ntitle: CRLF Doc\r\ndescription: Desc\r\n---\r\nBody\r\nMore",
		);

		expect(doc.title).toBe("CRLF Doc");
		expect(doc.description).toBe("Desc");
		expect(doc.text).toBe("Body\nMore");
	});

	it("keeps colons in quoted and bare values", () => {
		const doc = extractMarkdownFrontmatter(
			'---\ntitle: Best: The Movie\ndescription: "A: B"\n---\nBody',
		);

		expect(doc.title).toBe("Best: The Movie");
		expect(doc.description).toBe("A: B");
	});

	it("unescapes quoted YAML values", () => {
		const doc = extractMarkdownFrontmatter(
			"---\ntitle: \"She said \\\"hi\\\"\"\ndescription: 'It''s fine'\n---\nBody",
		);

		expect(doc.title).toBe('She said "hi"');
		expect(doc.description).toBe("It's fine");
	});
});

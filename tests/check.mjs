// Static checks for dist/ and unit checks for the helpers in src/app.js. Run after build: node tests/check.mjs
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const failures = [];
const fail = (msg) => failures.push(msg);

// Routes whose files are not built yet. Empty: every internal link is checked.
const PENDING_ROUTES = [];
const ALLOWED_EXTERNAL = /^https:\/\/(wa\.me\/|www\.google\.com\/maps\/)/;
const KB = 1024;
const BUDGET = { html: 28 * KB, css: 38 * KB, js: 9 * KB, book: 6 * KB, homes: 4 * KB, media: 80 * KB, variantsCss: 14 * KB, variantsJs: 6 * KB, switcherCss: 4 * KB };
// The design comes from build.mjs (id, menu name, base path, html data-design value). There is one: Client Original.
const DESIGN_LIST = [...readFileSync(join(root, 'build.mjs'), 'utf8').matchAll(/\{ id: '([\w-]+)', name: '([^']+)', base: '([^']*)', attr: '([\w-]+)' \}/g)].map(([, id, name, base, attr]) => ({ id, name, base, attr }));
const designOf = (page) => DESIGN_LIST.find((d) => d.base && page.startsWith(d.base.slice(1) + '/')) || DESIGN_LIST[0];
const HOMES = ['easystay', 'easystay-studio', 'luton-lodge', 'the-garden-nest', 'the-garden-studio'];
const CANONICAL = 'Short-stay homes near Luton Airport. Five properties, one team. Book direct with Luton Homes.';
const PREVIEW = 'Design preview: sample photos, prices and details.';
// The preview flag lives in build.mjs: when it is on, every page has the strip and the switcher.
const PREVIEW_ON = /^const PREVIEW = true;$/m.test(readFileSync(join(root, 'build.mjs'), 'utf8'));
const PAGES = ['index.html', 'homes/index.html', 'book/index.html', 'book/confirmed/index.html', 'about/index.html', 'contact/index.html', 'faq/index.html', '404.html'];

if (!existsSync(dist)) {
	console.error('dist/ is missing. Run node build.mjs first.');
	process.exit(1);
}

const files = readdirSync(dist, { recursive: true }).map(String).filter((f) => statSync(join(dist, f)).isFile());
const read = (f) => readFileSync(join(dist, f), 'utf8');
const variantsCss = read('assets/variants.css');
const switcherCss = read('assets/switcher.css');
const pages = files.filter((f) => f.endsWith('.html') && !f.startsWith('requirements/')); // the checklist is a standalone tool page
const idsIn = (f) => new Set([...read(f).matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

for (const page of pages) {
	const html = read(page);
	const name = relative(dist, join(dist, page));
	// Root addresses (/, /homes/, ...) are redirect pages: they forward to the same page in the design and nothing else.
	const refresh = html.match(/<meta http-equiv="refresh" content="0; url=([^"]+)">/);
	if (refresh) {
		// Root pages and the removed designs' pages (d/<old id>/...) both forward to the same page in the design.
		const expected = DESIGN_LIST[0].base + '/' + page.replace(/^d\/(?!client-original\/)[^/]+\//, '').replace(/index\.html$/, '');
		if (refresh[1] !== expected) fail(`${name}: redirects to ${refresh[1]}, must be ${expected}`);
		if (!existsSync(join(dist, refresh[1], 'index.html'))) fail(`${name}: redirect target ${refresh[1]} is not built`);
		if (!html.includes('<meta name="robots" content="noindex">')) fail(`${name}: missing noindex`);
		continue;
	}
	if (!/<title>[^<]+<\/title>/.test(html)) fail(`${name}: missing <title>`);
	if (!/<meta name="description" content="[^"]+">/.test(html)) fail(`${name}: missing meta description`);
	if (!html.includes('<meta name="robots" content="noindex">')) fail(`${name}: missing noindex`);
	if ((html.match(/<h1[\s>]/g) || []).length !== 1) fail(`${name}: must have exactly one <h1>`);
	if (!html.includes('<main id="content"')) fail(`${name}: missing main#content`);
	if (PREVIEW_ON !== html.includes(PREVIEW)) fail(`${name}: preview strip ${PREVIEW_ON ? 'missing' : 'must not be built'}`);
	// The design switcher is off: one design, nothing to switch to. Error pages are the same for every design.
	if (html.includes('data-switcher') || html.includes('design-switcher') || html.includes('/assets/switcher.js')) fail(`${name}: the design switcher must not be built`);
	const design = designOf(page);
	const local = design.base ? page.slice(design.base.length) : page;
	if (!html.includes(`<html lang="en-GB" data-design="${design.attr}">`)) fail(`${name}: <html> must carry data-design="${design.attr}"`);
	if (html.includes('theme-original')) fail(`${name}: theme-original.css is gone with the Original design`);
	if (/\/assets\/variants\.(css|js)/.test(html) && local !== 'index.html') fail(`${name}: variant files are for the home page only`);
	// Site links stay inside the page's own design (shared files excepted).
	for (const [, value] of html.replace(/<a class="strip-go"[^>]*>/, '').matchAll(/\s(?:href|action)="(\/[^"]*)"/g)) {
		if (/^\/(assets|fonts|media|favicon)/.test(value)) continue;
		if (design.base ? !value.startsWith(design.base + '/') : value.startsWith('/d/')) fail(`${name}: link ${value} leaves the ${design.name} design`);
	}
	if (!html.includes('<link rel="icon" href="/favicon.svg"')) fail(`${name}: favicon not linked`);
	for (const [img] of html.matchAll(/<img\b[^>]*>/g)) {
		if (!/\swidth=/.test(img) || !/\sheight=/.test(img)) fail(`${name}: <img> without width and height`);
		if (!/\salt="[^"]+"/.test(img)) fail(`${name}: <img> without alt text`);
		for (const [, url] of (img.match(/\ssrcset="([^"]*)"/) || [, ''])[1].matchAll(/(\S+)\s+\d+w/g)) {
			if (!existsSync(join(dist, url))) fail(`${name}: srcset "${url}" does not exist`);
		}
	}
	for (const [, attr, value] of html.matchAll(/\s(href|src|action)="([^"]*)"/g)) {
		if (/^https?:\/\//.test(value)) {
			if (attr !== 'href' || !ALLOWED_EXTERNAL.test(value)) fail(`${name}: external ${attr} ${value}`);
			continue;
		}
		if (/^(mailto:|tel:|data:)/.test(value)) continue;
		const [path, hash] = value.split('#');
		const route = path.split('?')[0] || '/' + page.replace(/index\.html$/, '');
		if (PENDING_ROUTES.includes(route)) continue;
		let target = route === '/' || route.endsWith('/') ? join(route, 'index.html') : route;
		if (!path && !value.startsWith('?')) target = page;
		if (!existsSync(join(dist, target))) {
			fail(`${name}: ${attr} "${value}" does not resolve`);
			continue;
		}
		if (hash && !idsIn(relative(dist, join(dist, target))).has(hash)) fail(`${name}: no id "${hash}" in ${target}`);
	}
	const size = Buffer.byteLength(html);
	// A home page that carries a room-by-room photo tour holds its photo markup, so it gets a larger HTML budget.
	if (size > (/homes\/[^/]+\/index\.html$/.test(name) ? 40 * KB : BUDGET.html)) fail(`${name}: ${size} bytes, budget ${BUDGET.html}`);
}

const assets = { 'assets/styles.css': BUDGET.css, 'assets/app.js': BUDGET.js, 'assets/book.js': BUDGET.book, 'assets/homes.js': BUDGET.homes, 'assets/variants.css': BUDGET.variantsCss, 'assets/variants.js': BUDGET.variantsJs, 'assets/switcher.css': BUDGET.switcherCss, 'assets/cal.js': 14 * KB, 'assets/quote.js': KB, 'assets/extras.css': 9 * KB, 'assets/ui.js': 8 * KB, 'assets/admin.js': 9 * KB, 'assets/admin-report.js': 12 * KB, 'assets/review.js': 3 * KB, 'assets/signin.js': 5 * KB };
for (const [file, budget] of Object.entries(assets)) {
	const text = read(file);
	if (Buffer.byteLength(text) > budget) fail(`${file}: ${Buffer.byteLength(text)} bytes, budget ${budget}`);
}

for (const file of files.filter((f) => f.startsWith('media/'))) {
	const size = statSync(join(dist, file)).size;
	// The Cinematic scrub video is the one large file (the 10k-websites target is 4 to 8 MB for a short 1080p clip);
	// its poster and stills get a still-image budget.
	const budget = file === 'media/cinematic/hero-scrub.mp4' ? 8 * 1024 * KB
		: file.startsWith('media/cinematic/') ? 120 * KB
		: file.startsWith('media/homes/') ? 110 * KB
		: file === 'media/c2-aerial.webp' ? 180 * KB
		: file === 'media/earth-night-se-england.webp' ? 100 * KB : BUDGET.media;
	if (size > budget) fail(`${file}: ${size} bytes, budget ${budget}`);
}

for (const file of files.filter((f) => /\.(html|css|js)$/.test(f))) {
	const text = read(file);
	if (/[\u2013\u2014]|&ndash;|&mdash;/.test(text)) fail(`${file}: contains an en or em dash`);
}

if (DESIGN_LIST.length !== 1 || DESIGN_LIST[0].id !== 'client-original' || DESIGN_LIST[0].base !== '/d/client-original') fail('build.mjs: the one design must be client-original, at /d/client-original');
for (const d of DESIGN_LIST) for (const page of PAGES) {
	// The 404 page is the host's page for every missing path, so it is built once at the root.
	const where = page === '404.html' ? page : join(d.base, page);
	if (!existsSync(join(dist, where))) fail(`${where}: not built`);
}
for (const page of PAGES.filter((p) => !/^404\.html$/.test(p))) {
	if (!existsSync(join(dist, page))) fail(`${page}: root redirect not built`);
}
for (const id of ['original', 'sky', 'departures', 'orbit', 'custom-1', 'custom-2', 'client-original2', 'cinematic']) {
	for (const page of PAGES.filter((p) => !/^(404|500)\.html$/.test(p))) {
		if (!existsSync(join(dist, 'd', id, page))) fail(`d/${id}/${page}: removed design redirect not built`);
	}
}
if (!existsSync(join(dist, 'favicon.svg'))) fail('favicon.svg: missing from dist');
// 500 page: Vercel does not serve a static custom 500 page on its own, so it is checked here directly.
if (!existsSync(join(dist, '500.html'))) {
	fail('500.html: not built');
} else {
	const page500 = read('500.html');
	if (!/<h1[^>]*>[^<]*\b500\b[^<]*<\/h1>/.test(page500)) fail('500.html: the h1 must contain 500');
	if (!page500.includes('<meta name="robots" content="noindex">')) fail('500.html: missing noindex');
	if (/[\u2013\u2014]/.test(page500)) fail('500.html: contains an en or em dash');
}
for (const d of DESIGN_LIST) {
	const at = (f) => (d.base ? d.base.slice(1) + '/' : '') + f;
	const homesHtml = read(at('homes/index.html'));
	const chips = [...homesHtml.matchAll(/<button type="button" class="chip"[^>]*data-tag="[^"]+"[^>]*aria-pressed="(?:true|false)"/g)];
	if (chips.length !== 5) fail(`${at('homes/index.html')}: expected 5 aria-pressed filter chips, found ${chips.length}`);
	if ((homesHtml.match(/<li class="reveal" data-tags="\|[^"]+\|"/g) || []).length !== HOMES.length) fail(`${at('homes/index.html')}: cards need data-tags`);
	if (!read(at('homes/easystay/index.html')).includes('<dialog id="lightbox"')) fail(`${at('homes/easystay/index.html')}: missing lightbox dialog`);
	if (PREVIEW_ON && (!read(at('index.html')).includes('/assets/variants.css') || !read(at('index.html')).includes('/assets/variants.js'))) fail(`${at('index.html')}: variant files not referenced`);
	if (!read(at('index.html')).includes(CANONICAL)) fail(`${at('index.html')}: canonical description missing or changed`);
	for (const slug of HOMES) {
		for (const file of [at('homes/index.html'), at(`homes/${slug}/index.html`)]) {
			if (!read(file).includes(`view-transition-name: home-${slug}"`)) fail(`${file}: missing view-transition-name home-${slug}`);
		}
	}
}
// Earth images: only from rules scoped to [data-design="orbit"], and nowhere else in the built site.
for (const [, selector, body] of variantsCss.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
	if (/earth-night/.test(body) && !/\[data-design="orbit"\]/.test(selector)) fail(`assets/variants.css: earth image outside [data-design="orbit"]: ${selector.trim()}`);
}
for (const file of files.filter((f) => /\.(html|js|css)$/.test(f) && f !== 'assets/variants.css')) {
	if (/earth-night/.test(read(file))) fail(`${file}: earth image referenced outside the orbit rules`);
}
if (!/\.design-switcher-button\s*\{[^}]*min-height:\s*48px/.test(switcherCss)) fail('assets/switcher.css: switcher button must be at least 48px high');
if (!/\.design-switcher-glyph\s*\{/.test(switcherCss) || !/\.design-switcher-chev\s*\{/.test(switcherCss)) fail('assets/switcher.css: switcher needs a glyph and a chevron');
if (!/\[data-design="dawn"\]:not\(\.dawn-go\)[^{]*\{[^}]*reveal-fallback/.test(variantsCss)) fail('assets/variants.css: dawn hero has no reveal-fallback');
if (!read('index.html').includes('<meta name="robots" content="noindex">')) fail('index.html: missing noindex');
const robots = read('robots.txt');
if (!/^Disallow: \/$/m.test(robots)) fail('robots.txt: missing Disallow: /');
const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'));
const hasNoindex = JSON.stringify(vercel.headers).includes('"X-Robots-Tag"') && JSON.stringify(vercel.headers).includes('"noindex"');
if (!hasNoindex) fail('vercel.json: X-Robots-Tag noindex header missing');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (pkg.type !== 'module') fail('package.json: type must be module');
if (!pkg.scripts?.test) fail('package.json: missing test script');
if (pkg.dependencies || pkg.devDependencies) fail('package.json: dependencies are not allowed');

// Motion and view-transition rules.
const css = readFileSync(join(root, 'src/styles.css'), 'utf8');
if (!css.includes('prefers-reduced-motion')) fail('styles.css: no prefers-reduced-motion block');
if (!css.includes('@view-transition')) fail('styles.css: no @view-transition rule');
if (!css.includes('reveal-fallback')) fail('styles.css: no reveal-fallback safety net for .reveal content');
// Every animation name used in styles.css must have a @keyframes rule. Keywords, times, timing functions, counts and var() are skipped.
const cssBare = (css + '\n' + variantsCss + '\n' + switcherCss).replace(/\/\*[\s\S]*?\*\//g, '');
const keyframeNames = new Set([...cssBare.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]));
const CSS_KEYWORD = /^(none|normal|reverse|alternate|alternate-reverse|forwards|backwards|both|infinite|running|paused|linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end|auto|!important)$/;
const CSS_NOT_A_NAME = /^-?[\d.]+(m?s)?$/;
for (const [, value] of cssBare.matchAll(/(?<![\w-])animation(?:-name)?\s*:\s*([^;{}]+)/g)) {
	for (const part of value.replace(/[\w-]+\([^()]*\)/g, '').split(',')) {
		for (const token of part.trim().split(/\s+/)) {
			if (!token || CSS_KEYWORD.test(token) || CSS_NOT_A_NAME.test(token)) continue;
			if (!keyframeNames.has(token)) fail(`styles.css: animation "${token}" is used but has no @keyframes`);
		}
	}
}

// Unit checks: evaluate app.js with no document; the module.exports guard supplies the helpers.
const src = readFileSync(join(root, 'src/app.js'), 'utf8');
for (const file of files.filter((f) => /\.(js|html)$/.test(f))) {
	if (/addEventListener\(\s*['"]scroll['"]/.test(read(file))) fail(`${file}: scroll event listener is not allowed`);
}
const mod = { exports: {} };
new Function('document', 'module', src)(undefined, mod);
const h = mod.exports;
const eq = (actual, expected, label) => {
	if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`app.js ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};
const quote = {};
new Function('module', read('assets/quote.js') + '\nmodule.exports = { lhQuote };')(quote);
eq(quote.exports.lhQuote(100, 3), { stay: 300, cleaning: 35, discount: 0, total: 335 }, 'quote short stay');
eq(quote.exports.lhQuote(100, 7), { stay: 700, cleaning: 35, discount: 70, total: 665 }, 'quote week discount');
const TODAY = '2026-10-25';
eq(h.lhIsDate('2026-11-12'), true, 'valid date');
eq(h.lhIsDate('2026-02-30'), false, 'impossible date');
eq(h.lhIsDate('12/11/2026'), false, 'wrong format');
eq(h.lhIsDate(undefined), false, 'undefined');
eq(h.lhFormatDate('2026-11-12'), '12 Nov 2026', 'format date');
eq(h.lhParseGuests('2'), 2, 'guests digits');
eq(h.lhParseGuests(' 3 '), 3, 'guests with spaces');
eq(h.lhParseGuests(4), 4, 'guests number');
for (const bad of ['0', '1.5', '1e2', '', '-1', 'two']) eq(h.lhParseGuests(bad), null, `guests ${JSON.stringify(bad)}`);
eq(h.lhStayErrors('2026-11-12', '2026-11-15', '2', TODAY), {}, 'valid stay');
eq(Object.keys(h.lhStayErrors('2026-10-24', '2026-10-26', '2', TODAY)), ['in'], 'past check in');
eq(Object.keys(h.lhStayErrors('2026-11-12', '2026-11-12', '2', TODAY)), ['out'], 'same day check out');
eq(Object.keys(h.lhStayErrors('2026-11-12', '2026-11-10', '2', TODAY)), ['out'], 'check out before check in');
eq(Object.keys(h.lhStayErrors('2026-11-12', '2026-11-15', '0', TODAY)), ['guests'], 'zero guests');
eq(Object.keys(h.lhStayErrors('', '', '', TODAY)).sort(), ['guests', 'in', 'out'], 'blank fields');
eq(h.lhEstimate(95, '2026-11-12', '2026-11-15'), { nights: 3, total: 285 }, 'estimate');
eq(h.lhEstimate(95, '2026-11-15', '2026-11-12'), null, 'estimate reversed');
eq(h.lhEstimate(95, 'x', '2026-11-12'), null, 'estimate invalid');

// Demo availability function (api/availability/[slug].js): reads a Lodgify calendar, answers booked or free per night.
const live = await import(new URL('../api/availability/%5Bslug%5D.js', import.meta.url));
const ics = (events) => 'BEGIN:VCALENDAR\r\n' + events.map((e) => 'BEGIN:VEVENT\r\n' + e + '\r\nEND:VEVENT\r\n').join('') + 'END:VCALENDAR\r\n';
const nightsOf = (text) => [...live.bookedNights(text)].sort((a, b) => a - b).map((n) => new Date(n * 864e5).toISOString().slice(0, 10));
eq(nightsOf(ics(['DTSTART;VALUE=DATE:20261110\r\nDTEND;VALUE=DATE:20261113'])), ['2026-11-10', '2026-11-11', '2026-11-12'], 'ical: check-out day is not a night');
eq(nightsOf(ics(['DTSTART:20261120T150000Z\r\nDTEND:20261122T100000Z'])), ['2026-11-20', '2026-11-21'], 'ical: date-times');
eq(nightsOf(ics(['DTSTART;VALUE=DATE:20261201'])), ['2026-12-01'], 'ical: no end is one night');
eq(nightsOf(ics(['DTSTART;VALUE=DATE:20261205\r\nDTEND;VALUE=DATE:20261207\r\nSTATUS:CANCELLED'])), [], 'ical: cancelled stays hold nothing');
eq(nightsOf(ics(['DTSTART;VALUE=DATE:20261301\r\nDTEND;VALUE=DATE:20261302', 'DTEND;VALUE=DATE:20261208'])), [], 'ical: bad dates and missing start are ignored');
eq(nightsOf(ics(['SUMMARY:A very long name that is\r\n  folded\r\nDTSTART;VALUE=DATE:20261215\r\nDTEND;VALUE=DATE:20261216'])), ['2026-12-15'], 'ical: folded lines');
const call = async (query, env, fetchImpl) => {
	const out = { headers: {} };
	const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return out; }, setHeader(k, v) { out.headers[k] = v; } };
	await live.default({ query }, res, { env, fetchImpl, now: () => Date.parse('2026-11-10T09:00:00Z') });
	return out;
};
const LINK = 'https://feed.example/secret-token.ics', ENV = { FEED_LODGIFY_THE_GARDEN_STUDIO: LINK };
const okFeed = async () => ({ ok: true, text: async () => ics(['DTSTART;VALUE=DATE:20261111\r\nDTEND;VALUE=DATE:20261113']) });
const hit = await call({ slug: 'the-garden-studio', days: '4' }, ENV, okFeed);
eq([hit.status, hit.body], [200, { home: 'the-garden-studio', from: '2026-11-10', days: { '2026-11-10': 'free', '2026-11-11': 'booked', '2026-11-12': 'booked', '2026-11-13': 'free' } }], 'availability function answer');
eq((await call({ slug: 'luton-lodge' }, ENV, okFeed)).status, 404, 'availability function: home without a calendar');
eq((await call({ slug: '../x' }, ENV, okFeed)).status, 404, 'availability function: odd slug');
const down = await call({ slug: 'the-garden-studio' }, ENV, async () => { throw new Error('boom ' + LINK); });
eq([down.status, JSON.stringify(down.body).includes('secret-token')], [502, false], 'availability function: failure never leaks the link');
eq(read('d/client-original/index.html').includes('<meta name="lh-cal" content="">'), true, 'calendar switch is off by default');

if (failures.length) {
	console.error(failures.map((f) => '- ' + f).join('\n'));
	console.error(`\n${failures.length} problem(s).`);
	process.exit(1);
}
console.log(`ok: ${pages.length} pages, ${files.length} files, unit checks passed`);

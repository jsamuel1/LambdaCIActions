// The console must declare its own icon (spec 04 § Tech choices).
//
// Why this is a test and not a comment in index.html:
//
//   A browser requests /favicon.ico on its own whenever no icon is declared. The console
//   bucket is private behind Origin Access Control, and S3 answers a request for a missing
//   key with 403 AccessDenied rather than 404 — so an undeclared icon means every page load
//   logs a bare "Failed to load resource: 403 ()" in devtools, with no initiator URL because
//   the request came from the browser rather than page code. That is indistinguishable at a
//   glance from a session/authorization failure, and it cost real triage time once already:
//   the management API's genuine denials are also 403s.
//
//   The distinguishing detail is the body — the API answers JSON, the S3 origin answers XML —
//   but nobody reads the body of a log line they believe is an auth error.
//
//   `errorResponses` on the distribution is NOT the fix and must not become one: CloudFront
//   custom error responses are distribution-wide, so rewriting 403 → /index.html would also
//   apply to the /api/* behavior and turn the management API's real 403/404 into 200 with an
//   HTML body, masking exactly the authorization denials an operator needs to see. That
//   reasoning lives in lib/web-stack.ts; this test keeps the icon that makes it unnecessary.
//
// Asserted on the BUILT output, because web/dist/index.html is what WebStack uploads to S3.
// Editing web/index.html without the copy step reaching dist would leave the deployed
// console still requesting /favicon.ico.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(repoRoot, 'web', 'index.html');
const BUILT = path.join(repoRoot, 'web', 'dist', 'index.html');

/** `<link rel="icon" ...>` tags, tolerant of attribute order and whitespace/newlines. */
function iconLinks(html) {
  return [...html.matchAll(/<link\b[^>]*>/gi)].filter((m) => /rel\s*=\s*["']icon["']/i.test(m[0]));
}

function assertDeclaresIcon(html, label) {
  const links = iconLinks(html);
  assert.equal(links.length, 1, `${label}: expected exactly one rel="icon" link, got ${links.length}`);
  const tag = links[0][0];

  const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag);
  assert.ok(href, `${label}: rel="icon" link has no href: ${tag}`);

  // A data: URI is the point — it is satisfied without a request, so the private S3 origin
  // is never asked for a key it does not have. A relative href would reintroduce the 403.
  assert.match(
    href[1],
    /^data:image\//,
    `${label}: icon href must be a data: URI so no origin request is made (got ${href[1].slice(0, 40)}…)`,
  );

  // `#` and `<`/`>` are not legal raw in an attribute-embedded URI: a raw `#` truncates the
  // SVG at the first fill colour and silently yields a blank icon in some browsers.
  const raw = href[1];
  assert.ok(!raw.includes('#'), `${label}: icon data URI must percent-encode '#' as %23`);
  assert.ok(!/[<>]/.test(raw), `${label}: icon data URI must percent-encode '<' and '>'`);
}

test('source index.html declares an inline icon', () => {
  assertDeclaresIcon(fs.readFileSync(SOURCE, 'utf8'), 'web/index.html');
});

test('built index.html carries the icon through to what S3 serves', (t) => {
  if (!fs.existsSync(BUILT)) {
    // `npm test` does not depend on `build:web`, and a credential-less synth on a fresh
    // clone deliberately tolerates an absent web/dist (see lib/web-stack.ts). Skip rather
    // than fail so this test does not invent a build ordering the repo does not have.
    t.skip('web/dist/index.html absent — run `npm run build:web` first');
    return;
  }
  assertDeclaresIcon(fs.readFileSync(BUILT, 'utf8'), 'web/dist/index.html');
});

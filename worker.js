// Cloudflare Worker — TetrisPlus edge entry.
//
// Two jobs:
//   1. Permanent-redirect `www.tetraplus.app` → `tetraplus.app` so the
//      apex is the single canonical URL (SEO + clean sharing).
//   2. Everything else falls through to the Static Assets binding, which
//      serves the Vite-built `project/dist/` bundle (HTML + JS + audio).
//
// Why a Worker script at all (we used to be pure-static):
//   Cloudflare's pure-asset deploy can't do host-level redirects without
//   a script. This file is the minimum needed to route `www` → apex
//   while keeping the rest of the static-assets contract intact.
//
// `env.ASSETS` binding is configured in wrangler.toml (`[assets]`
// section sets `binding = "ASSETS"`). Calling `env.ASSETS.fetch(request)`
// hands back to Cloudflare's built-in static-file handler — same
// behaviour as before this script existed.

const APEX_HOST = 'tetraplus.app';
const WWW_HOST  = 'www.tetraplus.app';

export default {
  /**
   * @param {Request} request
   * @param {{ ASSETS: { fetch: (req: Request) => Promise<Response> } }} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === WWW_HOST) {
      url.hostname = APEX_HOST;
      // 301 (permanent) so browsers + crawlers cache the canonical host.
      return Response.redirect(url.toString(), 301);
    }
    return env.ASSETS.fetch(request);
  },
};

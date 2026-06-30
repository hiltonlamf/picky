// Backward-compatibility shim. The parsing pipeline is now a two-phase flow:
//   POST /api/parse/discover  → finds menus (may ask the user to pick)
//   POST /api/parse/analyze   → analyses the chosen menu(s)
// Older clients that POST { url } here are transparently routed through the
// discover handler, which analyses inline when a site has a single menu.
export { POST, maxDuration } from './discover/route';

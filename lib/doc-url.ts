/**
 * URL normalisation for linked documents (menu PDFs).
 *
 * Its own module on purpose: both `lib/scraper.ts` (link discovery) and
 * `lib/ai.ts` (fetching the file to classify) need it, and scraper already
 * imports ai — putting it in either would make the cycle ai → scraper → ai.
 */

/**
 * Turn a document *share* link into something that actually returns the file.
 *
 * A Google Drive `/file/d/<id>/view` URL serves an HTML viewer page, not a PDF.
 * Fetching it and posting the bytes to the API as `application/pdf` fails every
 * time — after we have already paid for the call. waterkantamsterdam.nl links
 * its menu exactly this way, which is why the app reported "no menu listed on
 * this site" for a restaurant whose menu is one click from the homepage.
 *
 * Returns the URL unchanged when no rewrite applies.
 */
export function resolveDocumentUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();

    if (host === 'drive.google.com' || host.endsWith('.drive.google.com') || host === 'docs.google.com') {
      // /file/d/<id>/view  ·  /file/d/<id>/preview  ·  ?id=<id>
      const fromPath = /\/file\/d\/([^/]+)/.exec(u.pathname)?.[1];
      const id = fromPath ?? u.searchParams.get('id');
      if (id) return `https://drive.google.com/uc?export=download&id=${id}`;
    }

    if (host === 'dropbox.com' || host.endsWith('.dropbox.com')) {
      u.searchParams.set('dl', '1');
      return u.toString();
    }

    return url;
  } catch {
    return url;
  }
}

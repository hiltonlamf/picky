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
/** The Drive file id, from any of its share-link shapes. */
export function googleDriveFileId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host !== 'drive.google.com' && !host.endsWith('.drive.google.com') && host !== 'docs.google.com') {
      return null;
    }
    return /\/file\/d\/([^/]+)/.exec(u.pathname)?.[1] ?? u.searchParams.get('id');
  } catch {
    return null;
  }
}

export function resolveDocumentUrl(url: string): string {
  return documentUrlCandidates(url)[0];
}

/**
 * Every URL worth trying for one linked document, best first.
 *
 * Google Drive needs more than one: `uc?export=download` hands back the actual
 * bytes for small files, but for anything big enough to skip virus scanning it
 * returns an HTML "we can't scan this, continue?" interstitial instead. That is
 * what defeated waterkantamsterdam.nl — the menu link is a Drive share URL, the
 * rewrite looked right, and the download was still a web page. The
 * `drive.usercontent.google.com` endpoint with `confirm=t` is the post-consent
 * form, so try it as well rather than giving up on the restaurant.
 */
export function documentUrlCandidates(url: string): string[] {
  const driveId = googleDriveFileId(url);
  if (driveId) {
    return [
      `https://drive.usercontent.google.com/download?id=${driveId}&export=download&confirm=t`,
      `https://drive.google.com/uc?export=download&id=${driveId}`,
    ];
  }

  try {
    const u = new URL(url);
    if (u.hostname.toLowerCase().replace(/^www\./, '') === 'dropbox.com' || u.hostname.toLowerCase().endsWith('.dropbox.com')) {
      u.searchParams.set('dl', '1');
      return [u.toString()];
    }
  } catch {
    return [url];
  }

  return [url];
}

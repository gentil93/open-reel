/**
 * Where the site sends people. Left empty until the project is published:
 * the buttons then say the desktop app is coming instead of linking nowhere.
 */
export const LINKS: {
	/** The site's own address, ending in "/"; used to tell search engines about each language. */
	site: string | null;
	repository: string | null;
	releases: string | null;
} = {
	site: null,
	repository: null,
	releases: null,
};

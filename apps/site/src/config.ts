/**
 * Where the site sends people. `releases` stays empty until the first
 * release: the download buttons then say the desktop app is coming.
 */
export const LINKS: {
	/** The site's own address, ending in "/"; used to tell search engines about each language. */
	site: string | null;
	repository: string | null;
	releases: string | null;
} = {
	site: "https://gentil93.github.io/open-reel/",
	repository: "https://github.com/gentil93/open-reel",
	releases: null,
};

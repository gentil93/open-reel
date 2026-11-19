/**
 * The name the app had before Hatchlight. Installs made then keep their
 * folders, files, settings and environment under it, and keep working:
 * where only the old one is there, it is used as it is, never moved.
 *
 * The only place the old name is written; scripts/rename-to-hatchlight.ts
 * leaves this file alone.
 */
export const LEGACY_NAME = "open-reel";

/** The name folders, files and keys go by now. */
export const APP_NAME = "hatchlight";

/** An environment variable's name under an app name: HATCHLIGHT_DATA_DIR. */
export const envVariable = (name: string, suffix: string) =>
	`${name.toUpperCase().replaceAll("-", "_")}_${suffix}`;

/**
 * An environment variable, by what follows the app's name (`DATA_DIR` for
 * HATCHLIGHT_DATA_DIR), or else as it was called under the old name.
 */
export function appEnv(
	env: Record<string, string | undefined>,
	suffix: string,
): string | undefined {
	return (
		env[envVariable(APP_NAME, suffix)] ||
		env[envVariable(LEGACY_NAME, suffix)] ||
		undefined
	);
}

/** A key or file name under the old name: hatchlight.x is open-reel.x. */
export const legacyName = (name: string) =>
	name.startsWith(APP_NAME) ? LEGACY_NAME + name.slice(APP_NAME.length) : name;

/**
 * What the browser keeps under `key`, or under its old name while only that
 * one is set: the language, models and welcome chosen before the rename.
 */
export function storedValue(
	storage: { getItem(key: string): string | null },
	key: string,
): string | null {
	return storage.getItem(key) ?? storage.getItem(legacyName(key));
}

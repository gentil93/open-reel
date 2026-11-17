export type ErrorParams = Record<string, string | number>;

/**
 * Every error a person may see, by code. The interface has a message for each
 * one in every language; adding a code here means adding it to the catalogs.
 */
export const ERROR_CODES = [
	"assetNotFound",
	"downloadCutShort",
	"downloadFailed",
	"downloadTooLarge",
	"emptyKey",
	"engineExitCode",
	"engineMissing",
	"engineNoResult",
	"engineStopped",
	"engineUnpackFailed",
	"hashMismatch",
	"interrupted",
	"jobNotFound",
	"modelDoesNotRun",
	"modelUnavailable",
	"noApiKey",
	"noModel",
	"noReferences",
	"noResult",
	"notEnoughDisk",
	"notInstalled",
	"referenceNotFound",
	"referenceNotImage",
	"resultDownloadFailed",
	"resultNotHttps",
	"resultTooLarge",
	"sessionNotFound",
	"tooManyReferences",
	"unknownLocalModel",
	"unknownModel",
	"unknownProvider",
	"unknownVariant",
	"uploadType",
	"variantDoesNotRun",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * An error a person may see. Its `code` lets the interface show it in the
 * reader's language; `message` is the English text, for logs and for clients
 * that do not know the code. Values a message mentions go in `params`; byte
 * counts are named with a `Bytes` suffix so the interface can format them.
 */
export class CodedError extends Error {
	constructor(
		message: string,
		readonly code?: ErrorCode,
		readonly params: ErrorParams = {},
	) {
		super(message);
	}
}

/** The request is malformed or asks for something a model cannot do. */
export class ValidationError extends CodedError {}

export class NotFoundError extends CodedError {}

/** What to tell a person about an error: its message, and a code when known. */
export function describeError(error: unknown): {
	message: string;
	code: string | null;
	params: ErrorParams | null;
} {
	if (error instanceof CodedError && error.code) {
		return { message: error.message, code: error.code, params: error.params };
	}
	return {
		message: error instanceof Error ? error.message : String(error),
		code: null,
		params: null,
	};
}

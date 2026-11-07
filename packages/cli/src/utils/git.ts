import hostedGitInfo from "hosted-git-info";

export type GitSource = {
	type: "git";
	repo: string;
	host: string;
	path: string;
	ref?: string;
	pinned: boolean;
};

const urlPrefixes = ["http://", "https://", "ssh://", "git://", "git@"];

function decodeForValidation(value: string): string | null {
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
}

function needsHttpsPrefix(repo: string): boolean {
	return !urlPrefixes.some((prefix) => repo.startsWith(prefix));
}

function hasUnsafeGitInstallPart(value: string, allowSlash: boolean): boolean {
	const decoded = decodeForValidation(value);
	if (decoded === null) {
		return true;
	}

	for (const candidate of [value, decoded]) {
		const hasNull = candidate.includes("\0");
		const hasBackslash = candidate.includes("\\");
		const startsWithSlash = candidate.startsWith("/");
		if (hasNull || hasBackslash || startsWithSlash) return true;

		const hasNestedPath = !allowSlash && candidate.includes("/");
		if (hasNestedPath) return true;

		const hasParentSegment = candidate.split("/").includes("..");
		if (hasParentSegment) return true;
	}

	return false;
}

function buildGitSource(args: {
	repo: string;
	host: string;
	path: string;
	ref?: string;
}): GitSource | null {
	if (args.path.startsWith("/")) return null;

	const normalizedPath = args.path.replace(/\.git$/, "").replace(/^\/+/, "");
	const segments = normalizedPath.split("/");

	const isTooShort = !args.host || !normalizedPath || segments.length < 2;
	if (isTooShort) return null;

	const unsafeHost = hasUnsafeGitInstallPart(args.host, false);
	const unsafePath = hasUnsafeGitInstallPart(normalizedPath, true);
	if (unsafeHost || unsafePath) return null;

	return {
		type: "git",
		repo: args.repo,
		host: args.host,
		path: normalizedPath,
		ref: args.ref,
		pinned: Boolean(args.ref),
	};
}

function candidateUrls(
	prefix: string,
	repo: string,
	ref: string | undefined,
	url: string,
): string[] {
	const tagged = ref ? `${prefix}${repo}#${ref}` : undefined;
	return [tagged, `${prefix}${url}`].filter((value): value is string => Boolean(value));
}

function matchHostedSource(
	candidates: string[],
	repo: string,
	ref: string | undefined,
): GitSource | null {
	for (const candidate of candidates) {
		const info = hostedGitInfo.fromUrl(candidate);
		if (!info) continue;
		if (ref && info.project?.includes("@")) continue;

		return buildGitSource({
			repo,
			host: info.domain || "",
			path: `${info.user}/${info.project}`,
			ref: info.committish || ref || undefined,
		});
	}

	return null;
}

export function parseGitUrl(source: string): GitSource | null {
	const trimmed = source.trim();
	const hasGitPrefix = trimmed.startsWith("git:");
	const url = hasGitPrefix ? trimmed.slice(4).trim() : trimmed;

	if (!hasGitPrefix && !/^(https?|ssh|git):\/\//i.test(url)) {
		return null;
	}

	const split = splitRef(url);

	const directRepo = needsHttpsPrefix(split.repo) ? `https://${split.repo}` : split.repo;
	const directCandidates = candidateUrls("", split.repo, split.ref, url);
	const directSource = matchHostedSource(directCandidates, directRepo, split.ref);
	if (directSource) return directSource;

	const httpsRepo = `https://${split.repo}`;
	const httpsCandidates = candidateUrls("https://", split.repo, split.ref, url);
	const httpsSource = matchHostedSource(httpsCandidates, httpsRepo, split.ref);
	if (httpsSource) return httpsSource;

	return parseGenericGitUrl(url);
}

function splitRef(url: string): { repo: string; ref?: string } {
	const scpLikeMatch = url.match(/^git@([^:]+):(.+)$/);
	if (scpLikeMatch) {
		const pathWithMaybeRef = scpLikeMatch[2] ?? "";
		const refSeparator = pathWithMaybeRef.indexOf("@");
		if (refSeparator < 0) return { repo: url };

		const repoPath = pathWithMaybeRef.slice(0, refSeparator);
		const ref = pathWithMaybeRef.slice(refSeparator + 1);
		if (!repoPath || !ref) return { repo: url };

		return {
			repo: `git@${scpLikeMatch[1] ?? ""}:${repoPath}`,
			ref,
		};
	}

	if (url.includes("://")) {
		try {
			const parsed = new URL(url);
			const pathWithMaybeRef = parsed.pathname.replace(/^\/+/, "");
			const refSeparator = pathWithMaybeRef.indexOf("@");
			if (refSeparator < 0) return { repo: url };

			const repoPath = pathWithMaybeRef.slice(0, refSeparator);
			const ref = pathWithMaybeRef.slice(refSeparator + 1);
			if (!repoPath || !ref) return { repo: url };

			parsed.pathname = `/${repoPath}`;
			return {
				repo: parsed.toString().replace(/\/$/, ""),
				ref,
			};
		} catch {
			return { repo: url };
		}
	}

	const slashIndex = url.indexOf("/");
	if (slashIndex < 0) {
		return { repo: url };
	}

	const host = url.slice(0, slashIndex);
	const pathWithMaybeRef = url.slice(slashIndex + 1);
	const refSeparator = pathWithMaybeRef.indexOf("@");
	if (refSeparator < 0) {
		return { repo: url };
	}

	const repoPath = pathWithMaybeRef.slice(0, refSeparator);
	const ref = pathWithMaybeRef.slice(refSeparator + 1);
	if (!repoPath || !ref) {
		return { repo: url };
	}

	return {
		repo: `${host}/${repoPath}`,
		ref,
	};
}

function parseGenericGitUrl(url: string): GitSource | null {
	const { repo: repoWithoutRef, ref } = splitRef(url);
	let repo = repoWithoutRef;
	let host = "";
	let path = "";

	const scpLikeMatch = repoWithoutRef.match(/^git@([^:]+):(.+)$/);
	if (scpLikeMatch) {
		host = scpLikeMatch[1] ?? "";
		path = scpLikeMatch[2] ?? "";
	} else if (urlPrefixes.some((prefix) => repoWithoutRef.startsWith(prefix))) {
		try {
			const parsed = new URL(repoWithoutRef);
			host = parsed.hostname;
			path = parsed.pathname.replace(/^\/+/, "");
		} catch {
			return null;
		}
	} else {
		const slashIndex = repoWithoutRef.indexOf("/");
		if (slashIndex < 0) {
			return null;
		}

		host = repoWithoutRef.slice(0, slashIndex);
		path = repoWithoutRef.slice(slashIndex + 1);
		if (!host.includes(".") && host !== "localhost") {
			return null;
		}

		repo = `https://${repoWithoutRef}`;
	}

	return buildGitSource({ repo, host, path, ref });
}

import type { Draft, Op } from "./delta/index.ts";
import type { RemoteServiceProvider } from "./services/provider.ts";

export type { RemoteServiceError } from "./services/errors.ts";

export type { RemoteServiceProvider } from "./services/provider.ts";

export interface ContextKey<T> {
	readonly token: symbol;
	readonly valueType?: (value: T) => T;
}

export interface Context {
	readonly abortSignal: AbortSignal | undefined;
	value<T>(key: ContextKey<T>): T | undefined;
	toString(): string;
}

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

type IsAny<T> = 0 extends 1 & T ? true : false;

export type JsonRepresentation<T> = IsAny<T> extends true
	? JsonValue
	: unknown extends T
		? JsonValue
		: T extends null | boolean | number | string
			? T
			: T extends readonly (infer TItem)[]
				? JsonRepresentation<TItem>[]
				: T extends object
					? { [TKey in keyof T]: JsonRepresentation<T[TKey]> }
					: never;

export interface ReplicatedStateDelivery {
	readonly kind: "hydrate" | "update";
	readonly sequence: number;
}

export interface ReplicatedState<T> {
	readonly value: T | undefined;
	subscribe(
		listener: (value: T, context: Context, delivery: ReplicatedStateDelivery) => Promise<void>,
	): () => void;
	subscribe(
		listener: (value: T, context: Context, delivery: ReplicatedStateDelivery) => void,
	): () => void;
}

export interface MutableReplicatedState<T extends object> extends ReplicatedState<T> {
	readonly value: T;
	change(context: Context, mutate: (draft: Draft<T>) => void): void;
	replace(context: Context, value: T): void;
}

export interface ReplicatedStateSourceFrame<T> {
	readonly cursor: number;
	readonly value: T;
	readonly ops: readonly Op[];
	readonly context: Context;
}

export interface ReplicatedStateSourceAttachment<T> {
	readonly snapshot: { readonly value: T; readonly cursor: number };
	activate(listener: (frame: ReplicatedStateSourceFrame<T>) => void): void;
	dispose(): void;
}

export interface ReplicatedStateSource<T> {
	attach(): ReplicatedStateSourceAttachment<T>;
}

export interface ReplicatedStateSourceOptions {
	readonly onError?: (error: Error) => void;
}

export interface AttachedReplicatedState<T> extends ReplicatedState<T> {
	readonly value: T;
	dispose(): void;
}

export type ServiceMode = "singleton" | "keyed";

export interface Service<T> {
	readonly id: string;
	readonly local: boolean;
	readonly [SERVICE_TYPE]?: (value: T) => T;
}

type ReadonlyJsonValue =
	| null
	| boolean
	| number
	| string
	| readonly ReadonlyJsonValue[]
	| { readonly [key: string]: ReadonlyJsonValue };

type InvalidJsonPart<T> = IsAny<T> extends true
	? T
	: unknown extends T
		? never
		: [T] extends [ReadonlyJsonValue]
			? never
			: InvalidJsonStructure<T>;

type InvalidJsonProperty<T> = [Exclude<T, undefined>] extends [never]
	? T
	: InvalidJsonPart<Exclude<T, undefined>>;

type InvalidJsonStructure<T> = T extends null | boolean | number | string
	? never
	: T extends readonly (infer TItem)[]
		? InvalidJsonPart<TItem>
		: T extends (...args: never[]) => unknown
			? T
			: T extends object
				? { [TKey in keyof T]-?: InvalidJsonProperty<T[TKey]> }[keyof T]
				: T;

type InvalidRemoteMember<T> = T extends ReplicatedState<infer TValue>
	? InvalidJsonPart<TValue> extends never
		? never
		: "state value is not JSON"
	: T extends (...args: [...infer TArgs, Context]) => Promise<infer TResult>
		? InvalidJsonPart<TArgs[number]> extends never
			? TResult extends void
				? never
				: InvalidJsonPart<TResult> extends never
					? never
					: "method result is not JSON or void"
			: "method argument is not JSON"
		: "member is not a remote method or ReplicatedState";

type InvalidRemoteMemberNames<T> = {
	[TKey in keyof T]-?: InvalidRemoteMember<T[TKey]> extends never ? never : TKey;
}[keyof T];

export type RemoteServiceContract<T> = InvalidRemoteMemberNames<T> extends never ? T : never;

export interface ServiceSpawner<T> {
	spawn(key: string, implementation: T): () => void;
}

export interface RemoteServices {
	use<T>(service: Service<T>): T;
	observe<T>(
		service: Service<T>,
		handler: (service: T, context: Context) => void | Promise<void>,
	): () => void;
	ready(context: Context): Promise<void>;
	dispose(context: Context): Promise<void>;
}

export type ServiceCatalogueEntry = {
	readonly serviceId: string;
	readonly mode: ServiceMode;
};

export type ServiceInstanceAddress = {
	readonly key: string;
	readonly generation: number;
};

export type ServiceMemberSnapshot =
	| { readonly name: string; readonly kind: "method" }
	| {
			readonly name: string;
			readonly kind: "state";
			readonly sequence: number;
			readonly ops: readonly Op[];
	  };

export type ServiceInstanceSnapshot = {
	readonly instance?: ServiceInstanceAddress;
	readonly members: readonly ServiceMemberSnapshot[];
};

export type ServiceSubscriptionSnapshot = {
	readonly serviceId: string;
	readonly mode: ServiceMode;
	readonly instances: readonly ServiceInstanceSnapshot[];
};

export type ServiceProviderUpdate =
	| {
			readonly type: "state";
			readonly instance?: ServiceInstanceAddress;
			readonly member: string;
			readonly sequence: number;
			readonly ops: readonly Op[];
	  }
	| { readonly type: "reset"; readonly snapshot: ServiceSubscriptionSnapshot }
	| { readonly type: "unavailable" }
	| { readonly type: "replaced"; readonly snapshot: ServiceInstanceSnapshot }
	| { readonly type: "spawned"; readonly instance: ServiceInstanceSnapshot }
	| { readonly type: "closed"; readonly instance: ServiceInstanceAddress };

export type ServiceCall = {
	readonly serviceId: string;
	readonly instance?: ServiceInstanceAddress;
	readonly member: string;
	readonly args: readonly JsonValue[];
};

export interface ServiceSubscription {
	readonly snapshot: ServiceSubscriptionSnapshot;
	activate(): void;
	close(context?: Context): void | Promise<void>;
}

export interface RemoteServiceTransport {
	invoke(call: ServiceCall, context: Context): Promise<JsonValue | undefined>;
	subscribe(
		serviceId: string,
		mode: ServiceMode,
		listener: (update: ServiceProviderUpdate, context: Context) => void,
		context: Context,
	): Promise<ServiceSubscription>;
}

export interface RemoteServiceBindingOptions {
	readonly services: readonly { readonly id: string }[];
	readonly transport: RemoteServiceTransport;
	readonly bound?: boolean;
	readonly onError?: (error: Error) => void;
	readonly assertAccess?: () => void;
}

export interface RemoteServiceBinding extends RemoteServices {
	rebind(bound: boolean, context: Context): Promise<void>;
}

export interface FacetEnvironment {
	use<T>(service: Service<T>): T;
	observe<T>(
		service: Service<T>,
		handler: (service: T, context: Context) => void | Promise<void>,
	): void;
	provide<T>(service: Service<T>, implementation: NoInfer<T>): void;
	provideMany<T>(service: Service<T>): ServiceSpawner<T>;
	replicatedState<T extends object>(initial: T): MutableReplicatedState<T>;
	own(disposal: () => void | Promise<void>): void;
	onActivate(callback: () => void | Promise<void>): void;
	onDeactivate(callback: () => void | Promise<void>): void;
}

export interface Facet {
	readonly id: string;
	setup(env: FacetEnvironment): void;
}

export interface RemoteServiceSource {
	readonly acceptsUnavailableServices: boolean;
	catalogue(context: Context): Promise<readonly ServiceCatalogueEntry[]>;
	open(options: {
		readonly services: readonly { readonly id: string }[];
		assertAccess(): void;
		onError(error: Error): void;
	}): RemoteServices;
}

export interface FacetOptions {
	readonly facets: readonly Facet[];
	readonly serviceSources?: readonly RemoteServiceSource[];
	readonly onError?: (error: Error) => void;
}

export interface FacetHost {
	readonly services: RemoteServiceProvider;
	reload(facets: readonly Facet[]): Promise<void>;
	dispose(): Promise<void>;
}

export interface LoadedFacets {
	readonly facets: readonly Facet[];
	dispose(): Promise<void>;
}

export interface FacetLoader {
	load(): Promise<LoadedFacets>;
}

declare const SERVICE_TYPE: unique symbol;

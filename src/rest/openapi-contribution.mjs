// openapi-contribution.mjs — Route contribution contract
//
// Any handler that wants its endpoints included in the OpenAPI spec
// should implement the RouteContributor interface.
// See auth/handler.mjs for a reference implementation.

/**
 * @typedef {Object} OpenApiContribution
 * @property {Object<string, Object>} paths
 *   OpenAPI Path Item Objects keyed by path string (e.g. '/signup', '/upload').
 *   Each value is a standard OpenAPI 3.0.3 Path Item Object.
 *   May include a `servers` array to override the base URL for that path.
 *   Paths are merged directly into the spec's `paths` object.
 *
 * @property {Object<string, Object>} [schemas]
 *   Optional. OpenAPI Schema Objects to add to `components.schemas`.
 *   Keyed by schema name (e.g. 'AuthSession', 'UploadResponse').
 *   Referenced from paths via `$ref: '#/components/schemas/Name'`.
 */

/**
 * @typedef {Object} RouteContributor
 * @property {(baseUrl: string) => OpenApiContribution} getOpenApiPaths
 *   Returns the OpenAPI paths and schemas this handler contributes.
 *   `baseUrl` is the REST API base URL (e.g. 'https://host/rest/v1').
 *   Implementations may derive their own base URL from it
 *   (e.g. replacing '/rest/v1' with '/auth/v1').
 */

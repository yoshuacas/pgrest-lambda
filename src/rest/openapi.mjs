// openapi.mjs — Generate OpenAPI 3.0.3 spec from schema cache

function pgTypeToJsonSchema(pgType) {
  const t = pgType.toLowerCase().trim();

  if (['text', 'varchar', 'char', 'character varying'].includes(t)) {
    return { type: 'string' };
  }
  if (['integer', 'smallint', 'int4', 'int2'].includes(t)) {
    return { type: 'integer' };
  }
  if (['bigint', 'int8'].includes(t)) {
    return { type: 'integer' };
  }
  if (['boolean', 'bool'].includes(t)) {
    return { type: 'boolean' };
  }
  if (['numeric', 'real', 'double precision',
       'float4', 'float8'].includes(t)) {
    return { type: 'number' };
  }
  if (t === 'timestamp with time zone'
      || t === 'timestamp without time zone'
      || t === 'timestamptz') {
    return { type: 'string', format: 'date-time' };
  }
  if (t === 'date') {
    return { type: 'string', format: 'date' };
  }
  if (['jsonb', 'json'].includes(t)) {
    return { type: 'object' };
  }
  if (t === 'uuid') {
    return { type: 'string', format: 'uuid' };
  }
  return { type: 'string' };
}

function buildTableSchema(tableDef) {
  const properties = {};
  const required = [];
  for (const [colName, col] of Object.entries(tableDef.columns)) {
    properties[colName] = pgTypeToJsonSchema(col.type);
    if (!col.nullable && col.defaultValue === null) {
      required.push(colName);
    }
  }
  const schema = { type: 'object', properties };
  if (required.length > 0) {
    schema.required = required;
  }
  return schema;
}

function buildTablePaths(tableName, schemaRef) {
  return {
    get: {
      summary: `Read rows from ${tableName}`,
      description:
        `Retrieve rows from the ${tableName} table `
        + 'with PostgREST-style filtering.',
      parameters: [
        {
          name: 'select',
          in: 'query',
          description: 'Columns to return',
          schema: { type: 'string' },
        },
        {
          name: 'order',
          in: 'query',
          description: 'Sort order (e.g. id.asc)',
          schema: { type: 'string' },
        },
        {
          name: 'limit',
          in: 'query',
          description: 'Maximum rows to return',
          schema: { type: 'integer' },
        },
        {
          name: 'offset',
          in: 'query',
          description: 'Number of rows to skip',
          schema: { type: 'integer' },
        },
      ],
      responses: {
        200: {
          description: 'Successful response',
          content: {
            'application/json': {
              schema: {
                type: 'array',
                items: { $ref: schemaRef },
              },
            },
          },
        },
        default: {
          description: 'Error',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/PostgRESTError',
              },
            },
          },
        },
      },
    },
    post: {
      summary: `Insert rows into ${tableName}`,
      description: `Create new rows in the ${tableName} table.`,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: schemaRef },
          },
        },
      },
      responses: {
        201: {
          description: 'Created',
          content: {
            'application/json': {
              schema: { $ref: schemaRef },
            },
          },
        },
        default: {
          description: 'Error',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/PostgRESTError',
              },
            },
          },
        },
      },
    },
    patch: {
      summary: `Update rows in ${tableName}`,
      description:
        `Update existing rows in the ${tableName} table `
        + 'matching filter conditions.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: schemaRef },
          },
        },
      },
      responses: {
        200: {
          description: 'Updated',
          content: {
            'application/json': {
              schema: {
                type: 'array',
                items: { $ref: schemaRef },
              },
            },
          },
        },
        default: {
          description: 'Error',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/PostgRESTError',
              },
            },
          },
        },
      },
    },
    delete: {
      summary: `Delete rows from ${tableName}`,
      description:
        `Delete rows from the ${tableName} table `
        + 'matching filter conditions.',
      responses: {
        204: {
          description: 'Deleted',
        },
        default: {
          description: 'Error',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/PostgRESTError',
              },
            },
          },
        },
      },
    },
  };
}

function buildAuthPaths(authUrl) {
  const server = [{ url: authUrl }];
  const sessionRef = '#/components/schemas/AuthSession';
  const userRef = '#/components/schemas/AuthUser';
  const errorRef = '#/components/schemas/AuthError';
  const tag = 'Auth';

  return {
    '/signup': {
      servers: server,
      post: {
        tags: [tag],
        summary: 'Sign up',
        description: 'Create a new user account with email and password.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string', minLength: 8 },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Account created', content: { 'application/json': { schema: { $ref: sessionRef } } } },
          400: { description: 'Validation error or user exists', content: { 'application/json': { schema: { $ref: errorRef } } } },
        },
        security: [],
      },
    },
    '/token?grant_type=password': {
      servers: server,
      post: {
        tags: [tag],
        summary: 'Sign in',
        description: 'Authenticate with email and password.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Authenticated', content: { 'application/json': { schema: { $ref: sessionRef } } } },
          400: { description: 'Invalid credentials', content: { 'application/json': { schema: { $ref: errorRef } } } },
        },
        security: [],
      },
    },
    '/token?grant_type=refresh_token': {
      servers: server,
      post: {
        tags: [tag],
        summary: 'Refresh token',
        description: 'Get a new access token using a refresh token.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['refresh_token'],
                properties: {
                  refresh_token: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Token refreshed', content: { 'application/json': { schema: { $ref: sessionRef } } } },
          401: { description: 'Invalid refresh token', content: { 'application/json': { schema: { $ref: errorRef } } } },
        },
        security: [],
      },
    },
    '/user': {
      servers: server,
      get: {
        tags: [tag],
        summary: 'Get current user',
        description: 'Retrieve the authenticated user profile.',
        responses: {
          200: { description: 'User profile', content: { 'application/json': { schema: { $ref: userRef } } } },
          401: { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: errorRef } } } },
        },
      },
    },
    '/logout': {
      servers: server,
      post: {
        tags: [tag],
        summary: 'Sign out',
        description: 'Invalidate the current session.',
        responses: {
          204: { description: 'Signed out' },
        },
      },
    },
  };
}

export function generateSpec(schema, apiUrl) {
  const paths = {};
  const schemas = {};

  for (const [tableName, tableDef]
       of Object.entries(schema.tables)) {
    schemas[tableName] = buildTableSchema(tableDef);
    const ref = `#/components/schemas/${tableName}`;
    paths[`/${tableName}`] = { ...buildTablePaths(tableName, ref), tags: undefined };
    // Tag REST endpoints
    for (const op of Object.values(paths[`/${tableName}`])) {
      if (op && typeof op === 'object' && op.summary) {
        op.tags = ['Data'];
      }
    }
  }

  // Auth endpoints
  const authUrl = apiUrl.replace(/\/rest\/v1\/?$/, '/auth/v1');
  const authPaths = buildAuthPaths(authUrl);
  Object.assign(paths, authPaths);

  schemas.PostgRESTError = {
    type: 'object',
    properties: {
      code: { type: 'string' },
      message: { type: 'string' },
      details: { type: 'string' },
      hint: { type: 'string' },
    },
  };

  schemas.AuthSession = {
    type: 'object',
    properties: {
      access_token: { type: 'string' },
      token_type: { type: 'string', example: 'bearer' },
      expires_in: { type: 'integer', example: 3600 },
      refresh_token: { type: 'string' },
      user: { $ref: '#/components/schemas/AuthUser' },
    },
  };

  schemas.AuthUser = {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      email: { type: 'string', format: 'email' },
      app_metadata: { type: 'object' },
      user_metadata: { type: 'object' },
      created_at: { type: 'string', format: 'date-time' },
    },
  };

  schemas.AuthError = {
    type: 'object',
    properties: {
      error: { type: 'string' },
      error_description: { type: 'string' },
    },
  };

  return {
    openapi: '3.0.3',
    info: {
      title: 'pgrest-lambda API',
      version: '0.1.0',
    },
    servers: [{ url: apiUrl }],
    paths,
    components: {
      schemas,
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
    security: [{ BearerAuth: [] }],
  };
}

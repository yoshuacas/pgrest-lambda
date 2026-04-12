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

export function generateSpec(schema, apiUrl) {
  const paths = {};
  const schemas = {};

  for (const [tableName, tableDef]
       of Object.entries(schema.tables)) {
    schemas[tableName] = buildTableSchema(tableDef);
    const ref = `#/components/schemas/${tableName}`;
    paths[`/${tableName}`] = buildTablePaths(tableName, ref);
  }

  schemas.PostgRESTError = {
    type: 'object',
    properties: {
      code: { type: 'string' },
      message: { type: 'string' },
      details: { type: 'string' },
      hint: { type: 'string' },
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

import swaggerJsdoc from 'swagger-jsdoc';
import path from 'path';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Soroban Smart Block Explorer API',
      version: '1.0.0',
      description: 'Human-readable Soroban contract explorer. Decodes raw XDR into plain English.',
    },
    servers: [{ url: '/api/v1', description: 'API v1' }],
  },
  // Scan all route files for @swagger JSDoc comments
  apis: [path.join(__dirname, '../api/*.ts'), path.join(__dirname, '../api/*.js')],
};

export const swaggerSpec = swaggerJsdoc(options);

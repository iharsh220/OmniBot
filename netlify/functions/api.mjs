// Netlify Function: runs the OmniChat Express app via serverless-http.
// netlify.toml rewrites /api/*, /auth/* and /webhooks/* to this function.
import './_env.mjs'; // must be first: switches storage to Netlify Blobs
import serverless from 'serverless-http';
import { connectLambda } from '@netlify/blobs';
import app from '../../server/app.js';

const run = serverless(app, { binary: false });

export const handler = async (event, context) => {
  connectLambda(event); // gives Netlify Blobs its credentials for this request
  return run(event, context);
};

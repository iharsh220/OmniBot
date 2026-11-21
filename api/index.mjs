process.env.OMNICHAT_STORE ||= 'kv';

import serverless from 'serverless-http';
import app from '../server/app.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default serverless(app);

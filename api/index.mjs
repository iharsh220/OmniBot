process.env.OMNICHAT_STORE ||= 'kv';

import app from '../app.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default function handler(req, res) {
  return app(req, res);
}

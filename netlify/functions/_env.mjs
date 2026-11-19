// Loaded before the app: on Netlify, store data in Netlify Blobs instead of a local file.
process.env.OMNICHAT_STORE ||= 'blobs';

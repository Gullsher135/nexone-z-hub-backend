import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env.js';
import router from './routes/index.js';
import { errorHandler, notFound } from './middleware/error.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', env.trustProxy); // Render sits behind a proxy

  app.use(helmet());
  app.use(
    cors({
      origin(origin, cb) {
        // allow tools without an Origin header (curl, health checks) and listed frontends
        if (!origin || env.clientUrls.includes(origin)) return cb(null, true);
        return cb(new Error(`Origin not allowed by CORS: ${origin}`));
      },
      credentials: true,
    })
  );
  app.use(express.json({ limit: '1mb' }));
  if (!env.isProd) app.use(morgan('dev'));

  app.get('/', (_req, res) => res.json({ name: 'NexoneZ Attendance API', status: 'running' }));
  app.use('/api', router);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

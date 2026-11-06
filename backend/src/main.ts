import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { json } from 'express';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.enableCors({ origin: true });
  app.use(json({ limit: '10mb' }));
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
}

void bootstrap();

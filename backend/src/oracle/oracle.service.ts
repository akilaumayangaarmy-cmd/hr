import { Injectable, Logger, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import * as oracledb from 'oracledb';

@Injectable()
export class OracleService implements OnModuleDestroy {
  private readonly logger = new Logger(OracleService.name);
  private clientInitialized = false;
  private poolPromise: Promise<oracledb.Pool> | null = null;

  async withConnection<T>(work: (connection: oracledb.Connection) => Promise<T>): Promise<T> {
    const pool = await this.getPool();
    const connection = await pool.getConnection();
    try {
      return await work(connection);
    } finally {
      await connection.close();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.poolPromise) {
      const pool = await this.poolPromise;
      await pool.close(10);
      this.poolPromise = null;
    }
  }

  async withTransaction<T>(connection: oracledb.Connection, work: () => Promise<T>): Promise<T> {
    try {
      const result = await work();
      await connection.commit();
      return result;
    } catch (error) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        this.logger.error('Failed to roll back the Oracle migration transaction', rollbackError);
      }
      throw error;
    }
  }

  private async getPool(): Promise<oracledb.Pool> {
    if (this.poolPromise) return this.poolPromise;
    const user = process.env.ORACLE_USER;
    const password = process.env.ORACLE_PASSWORD;
    const connectString = process.env.ORACLE_CONNECT_STRING;
    if (!user || !password || !connectString) {
      throw new ServiceUnavailableException('Oracle connection is not configured. Set the ORACLE_* environment variables.');
    }

    if (!this.clientInitialized && process.env.ORACLE_CLIENT_LIB) {
      oracledb.initOracleClient({ libDir: process.env.ORACLE_CLIENT_LIB });
      this.clientInitialized = true;
    }

    this.poolPromise = oracledb.createPool({ user, password, connectString, poolMin: 1, poolMax: 10, poolIncrement: 1 });
    try {
      return await this.poolPromise;
    } catch (error) {
      this.poolPromise = null;
      throw error;
    }
  }
}

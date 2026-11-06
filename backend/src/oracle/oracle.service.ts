import { Injectable, Logger, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import * as oracledb from 'oracledb';
import { quoteIdent } from '../metadata/identifiers';
import { renderTableDdl } from '../metadata/render-ddl';
import { getTable, MEMBER_TABLE_KEY } from '../metadata/table-registry';

@Injectable()
export class OracleService implements OnModuleDestroy, OnModuleInit {
  private readonly logger = new Logger(OracleService.name);
  private clientInitialized = false;
  private poolPromise: Promise<oracledb.Pool> | null = null;

  async onModuleInit(): Promise<void> {
    const table = getTable(MEMBER_TABLE_KEY);
    if (!table) throw new Error(`Table metadata is missing for ${MEMBER_TABLE_KEY}`);

    await this.withConnection(async (connection) => {
      if (await this.tableExists(connection, table.physicalName)) {
        this.logger.log(`Oracle table "${table.physicalName}" already exists`);
      } else {
        try {
          await connection.execute(renderTableDdl(table));
          this.logger.log(`Created Oracle table "${table.physicalName}"`);
        } catch (error) {
          if (!isObjectAlreadyExistsError(error) || !(await this.tableExists(connection, table.physicalName))) {
            throw error;
          }
          this.logger.log(`Oracle table "${table.physicalName}" was created by another process`);
        }
      }

      for (const column of table.columns) {
        const columnResult = await connection.execute<{ NULLABLE: string; DATA_LENGTH: number }>(
          'SELECT NULLABLE, DATA_LENGTH FROM USER_TAB_COLUMNS WHERE TABLE_NAME = :tableName AND COLUMN_NAME = :columnName',
          { tableName: table.physicalName, columnName: column.physicalName },
          { outFormat: oracledb.OUT_FORMAT_OBJECT },
        );
        const existingColumn = columnResult.rows?.[0];
        if (column.nullable && existingColumn?.NULLABLE === 'N') {
          await connection.execute(
            `ALTER TABLE ${quoteIdent(table.quoteTableName ?? table.quoteIdentifiers, table.physicalName)} MODIFY (${quoteIdent(table.quoteIdentifiers, column.physicalName)} NULL)`,
          );
          this.logger.log(`Made Oracle column "${column.physicalName}" nullable`);
        }
        if (
          column.type === 'string' &&
          column.length != null &&
          existingColumn != null &&
          existingColumn.DATA_LENGTH < column.length
        ) {
          await connection.execute(
            `ALTER TABLE ${quoteIdent(table.quoteTableName ?? table.quoteIdentifiers, table.physicalName)} MODIFY (${quoteIdent(table.quoteIdentifiers, column.physicalName)} VARCHAR2(${column.length}))`,
          );
          this.logger.log(`Expanded Oracle column "${column.physicalName}" to ${column.length} bytes`);
        }
      }
    });
  }

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

  private async tableExists(connection: oracledb.Connection, tableName: string): Promise<boolean> {
    const result = await connection.execute<{ TABLE_COUNT: number }>(
      'SELECT COUNT(*) AS TABLE_COUNT FROM USER_TABLES WHERE TABLE_NAME = :tableName',
      { tableName },
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    return (result.rows?.[0]?.TABLE_COUNT ?? 0) > 0;
  }
}

function isObjectAlreadyExistsError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'errorNum' in error && error.errorNum === 955;
}

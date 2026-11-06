import { Module } from '@nestjs/common';
import { MigrationController } from './migration/migration.controller';
import { MigrationService } from './migration/migration.service';
import { OracleService } from './oracle/oracle.service';

@Module({
  controllers: [MigrationController],
  providers: [MigrationService, OracleService],
})
export class AppModule {}

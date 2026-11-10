import { Module } from '@nestjs/common';
import { OracleModule } from '../oracle/oracle.module';
import { MigrationController } from './migration.controller';
import { MigrationService } from './migration.service';

@Module({
  imports: [OracleModule],
  controllers: [MigrationController],
  providers: [MigrationService],
})
export class MigrationModule {}

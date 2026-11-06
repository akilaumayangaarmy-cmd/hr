import { Body, Controller, Get, Post } from '@nestjs/common';
import { listTables, toTableMeta } from '../metadata/table-registry';
import { MigrationService, UpsertRequest } from './migration.service';

@Controller('api/migration')
export class MigrationController {
  constructor(private readonly migrationService: MigrationService) {}

  @Get('tables')
  listTables() {
    return listTables().map(toTableMeta);
  }

  @Post('upsert')
  upsert(@Body() body: UpsertRequest) {
    return this.migrationService.upsert(body);
  }
}

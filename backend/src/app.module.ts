import { Module } from '@nestjs/common';
import { MemberMergeModule } from './member-merge/member-merge.module';
import { MigrationModule } from './migration/migration.module';

@Module({
  imports: [MigrationModule, MemberMergeModule],
})
export class AppModule {}

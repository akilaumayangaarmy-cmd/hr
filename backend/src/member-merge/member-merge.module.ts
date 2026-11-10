import { Module } from '@nestjs/common';
import { OracleModule } from '../oracle/oracle.module';
import { MemberMergeController } from './member-merge.controller';
import { MemberMergeService } from './member-merge.service';

@Module({
  imports: [OracleModule],
  controllers: [MemberMergeController],
  providers: [MemberMergeService],
})
export class MemberMergeModule {}

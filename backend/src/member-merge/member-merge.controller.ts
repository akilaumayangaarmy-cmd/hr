import { Controller, Post } from '@nestjs/common';
import { MemberMergeService } from './member-merge.service';

@Controller('api/migration')
export class MemberMergeController {
  constructor(private readonly memberMergeService: MemberMergeService) {}

  @Post('merge-members')
  mergeMembers() {
    return this.memberMergeService.mergeMembers();
  }

  @Post('create-default-data')
  createDefaultData() {
    return this.memberMergeService.createDefaultData();
  }
}

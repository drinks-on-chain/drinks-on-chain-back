import { PartialType } from '@nestjs/swagger';
import { CreateHarvestBatchDto } from './create-harvest-batch.dto';

export class UpdateHarvestBatchDto extends PartialType(CreateHarvestBatchDto) {}

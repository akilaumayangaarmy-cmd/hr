import { labelize, typeLabel } from './labels';
import { ColumnDef, ColumnMeta, TableDef, TableGroup, TableMeta } from './types';

export const MEMBER_TABLE_KEY = '02_Temp_members_master_data';

function column(partial: Omit<ColumnDef, 'label' | 'physicalName'> & { physicalName?: string; label?: string }): ColumnDef {
  return {
    ...partial,
    physicalName: partial.physicalName ?? partial.name,
    label: partial.label ?? labelize(partial.name),
  };
}

function memberString(name: string, length: number, required = false, lookup?: string): ColumnDef {
  return column({
    name,
    type: 'string',
    length,
    nullable: !required,
    requiredOnInsert: required,
    lookup: lookup ? { table: lookup } : undefined,
  });
}

function memberNumber(name: string, required = false, precision = 38, scale = 0): ColumnDef {
  return column({
    name,
    type: 'number',
    precision,
    scale,
    nullable: !required,
    requiredOnInsert: required,
  });
}

function memberDate(name: string): ColumnDef {
  return column({ name, type: 'date', nullable: true, requiredOnInsert: false });
}

function memberFlag(name: string, opts?: { nullable?: boolean; databaseDefault?: number }): ColumnDef {
  return column({
    name,
    type: 'flag',
    precision: 1,
    scale: 0,
    nullable: opts?.nullable ?? true,
    requiredOnInsert: false,
    databaseDefault: opts?.databaseDefault,
  });
}

function fk(name: string, table: string): ColumnDef {
  return memberString(name, 255, false, table);
}

const memberColumns: ColumnDef[] = [
  memberFlag('is_active', { nullable: false, databaseDefault: 1 }),
  memberNumber('e_number'),
  memberString('regiment_number', 100),
  memberString('name', 255),
  memberString('address', 1000),
  fk('province_id', 'provinces'),
  fk('district_id', 'districts'),
  fk('divisional_secretariat_id', 'divisional_secretariats'),
  fk('gn_division_id', 'gn_divisions'),
  fk('appointment_id', 'appointments'),
  fk('bank_id', 'banks'),
  fk('branch_id', 'bank_branches'),
  fk('blood_group_id', 'blood_groups'),
  fk('eye_colour_id', 'eye_colours'),
  fk('gender_id', 'genders'),
  fk('race_id', 'races'),
  fk('religion_id', 'religions'),
  fk('skin_colour_id', 'skin_colours'),
  fk('council_type_id', 'council_types'),
  fk('decoration_id', 'decorations'),
  fk('dependent_type_id', 'dependent_types'),
  fk('member_category_id', 'member_categories'),
  memberString('cadet_no', 50),
  memberString('intake_no', 50),
  memberString('first_name', 100),
  memberString('last_name', 100),
  memberString('initial', 50),
  memberString('full_name', 255),
  memberString('other_name', 255),
  memberNumber('contact_number_home'),
  memberNumber('contact_number_personal'),
  memberDate('date_of_birth'),
  memberString('birth_place', 255),
  memberString('hometown', 255),
  memberString('nationality', 100),
  memberNumber('height', false, 10, 0),
  memberNumber('chest', false, 10, 0),
  memberNumber('weight', false, 10, 0),
  memberString('nic', 20),
  memberString('driving_licence', 50),
  memberString('passport_no', 20),
  memberFlag('dual_citizenship'),
  memberString('dual_citizenship_country', 100),
  fk('regiment_id', 'regiments'),
  fk('unit_id', 'units'),
  memberString('account_number', 100),
  fk('electorate_division_id', 'electorate_divisions'),
  fk('rank_id', 'ranks'),
  fk('trade_id', 'trades'),
  fk('grade_id', 'grades'),
  fk('class_id', 'classes'),
  memberString('recruit_number', 100),
  fk('member_service_type_id', 'member_service_types'),
  fk('star1_classification_id', 'star_classifications'),
  fk('star2_classification_id', 'star_classifications'),
  fk('star3_classification_id', 'star_classifications'),
  memberDate('star1_awarded_date'),
  memberDate('star2_awarded_date'),
  memberDate('star3_awarded_date'),
  fk('mother_regiment_id', 'regiments'),
  fk('mother_unit_id', 'units'),
  memberDate('temporary_rank_promoted_date'),
  memberDate('rank_confirmation_date'),
  memberFlag('is_temporary_rank'),
  fk('marital_status_id', 'marital_statuses'),
  fk('sub_appointment_id', 'sub_appointments'),
  memberNumber('old_id', true),
];

function referenceColumns(parents: { name: string; table: string }[]): ColumnDef[] {
  const columns: ColumnDef[] = [
    {
      name: 'id',
      physicalName: 'ID',
      label: 'ID',
      type: 'string',
      length: 36,
      nullable: false,
      requiredOnInsert: false,
      generateOnInsert: true,
    },
    {
      name: 'name',
      physicalName: 'NAME',
      label: 'Name',
      type: 'string',
      length: 255,
      nullable: false,
      requiredOnInsert: true,
    },
    {
      name: 'code',
      physicalName: 'CODE',
      label: 'Code',
      type: 'string',
      length: 50,
      nullable: true,
      requiredOnInsert: false,
    },
    {
      name: 'description',
      physicalName: 'DESCRIPTION',
      label: 'Description',
      type: 'string',
      length: 1000,
      nullable: true,
      requiredOnInsert: false,
    },
  ];
  for (const parent of parents) {
    columns.push({
      name: parent.name,
      physicalName: parent.name.toUpperCase(),
      label: labelize(parent.name),
      type: 'string',
      length: 36,
      nullable: true,
      requiredOnInsert: false,
      lookup: { table: parent.table },
    });
  }
  columns.push(
    {
      name: 'is_active',
      physicalName: 'IS_ACTIVE',
      label: 'Is Active',
      type: 'flag',
      precision: 1,
      scale: 0,
      nullable: false,
      requiredOnInsert: false,
      databaseDefault: 1,
    },
    {
      name: 'old_id',
      physicalName: 'OLD_ID',
      label: 'Old ID',
      type: 'number',
      precision: 38,
      scale: 0,
      nullable: false,
      requiredOnInsert: true,
    },
  );
  return columns;
}

function lookup(opts: {
  key: string;
  label: string;
  description: string;
  group: TableGroup;
  loadOrder: number;
  parents?: { name: string; table: string }[];
}): TableDef {
  return {
    key: opts.key,
    label: opts.label,
    description: opts.description,
    group: opts.group,
    loadOrder: opts.loadOrder,
    physicalName: opts.key,
    quoteIdentifiers: false,
    quoteTableName: true,
    businessKey: 'old_id',
    surrogateKey: 'id',
    columns: referenceColumns(opts.parents ?? []),
  };
}

const TABLES: TableDef[] = [
  {
    key: MEMBER_TABLE_KEY,
    label: 'Temporary members master',
    description:
      'Staging table for member master data. Rows are merged on old_id. Lookup columns store the related row id, and numeric or code values can be resolved before the merge.',
    group: 'master',
    loadOrder: 100,
    physicalName: MEMBER_TABLE_KEY,
    quoteIdentifiers: true,
    businessKey: 'old_id',
    surrogateKey: null,
    columns: memberColumns,
  },
  lookup({
    key: 'provinces',
    label: 'Provinces',
    description: 'Province reference data.',
    group: 'geography',
    loadOrder: 10,
  }),
  lookup({
    key: 'districts',
    label: 'Districts',
    description: 'District reference data.',
    group: 'geography',
    loadOrder: 11,
    parents: [{ name: 'province_id', table: 'provinces' }],
  }),
  lookup({
    key: 'divisional_secretariats',
    label: 'Divisional secretariats',
    description: 'Divisional secretariat reference data.',
    group: 'geography',
    loadOrder: 12,
    parents: [{ name: 'district_id', table: 'districts' }],
  }),
  lookup({
    key: 'gn_divisions',
    label: 'GN divisions',
    description: 'Grama Niladhari division reference data.',
    group: 'geography',
    loadOrder: 13,
    parents: [{ name: 'divisional_secretariat_id', table: 'divisional_secretariats' }],
  }),
  lookup({
    key: 'electorate_divisions',
    label: 'Electorate divisions',
    description: 'Electorate division reference data.',
    group: 'geography',
    loadOrder: 14,
    parents: [{ name: 'province_id', table: 'provinces' }],
  }),
  lookup({
    key: 'banks',
    label: 'Banks',
    description: 'Bank reference data.',
    group: 'reference',
    loadOrder: 20,
  }),
  lookup({
    key: 'bank_branches',
    label: 'Bank branches',
    description: 'Bank branch reference data.',
    group: 'reference',
    loadOrder: 21,
    parents: [{ name: 'bank_id', table: 'banks' }],
  }),
  lookup({ key: 'blood_groups', label: 'Blood groups', description: 'Blood group reference data.', group: 'reference', loadOrder: 30 }),
  lookup({ key: 'eye_colours', label: 'Eye colours', description: 'Eye colour reference data.', group: 'reference', loadOrder: 31 }),
  lookup({ key: 'genders', label: 'Genders', description: 'Gender reference data.', group: 'reference', loadOrder: 32 }),
  lookup({ key: 'races', label: 'Races', description: 'Race reference data.', group: 'reference', loadOrder: 33 }),
  lookup({ key: 'religions', label: 'Religions', description: 'Religion reference data.', group: 'reference', loadOrder: 34 }),
  lookup({ key: 'skin_colours', label: 'Skin colours', description: 'Skin colour reference data.', group: 'reference', loadOrder: 35 }),
  lookup({ key: 'council_types', label: 'Council types', description: 'Council type reference data.', group: 'reference', loadOrder: 36 }),
  lookup({ key: 'decorations', label: 'Decorations', description: 'Decoration reference data.', group: 'reference', loadOrder: 37 }),
  lookup({ key: 'dependent_types', label: 'Dependent types', description: 'Dependent type reference data.', group: 'reference', loadOrder: 38 }),
  lookup({ key: 'member_categories', label: 'Member categories', description: 'Member category reference data.', group: 'reference', loadOrder: 39 }),
  lookup({ key: 'marital_statuses', label: 'Marital statuses', description: 'Marital status reference data.', group: 'reference', loadOrder: 40 }),
  lookup({ key: 'star_classifications', label: 'Star classifications', description: 'Star classification reference data.', group: 'reference', loadOrder: 41 }),
  lookup({ key: 'appointments', label: 'Appointments', description: 'Appointment reference data.', group: 'organisation', loadOrder: 50 }),
  lookup({
    key: 'sub_appointments',
    label: 'Sub appointments',
    description: 'Sub appointment reference data.',
    group: 'organisation',
    loadOrder: 51,
    parents: [{ name: 'appointment_id', table: 'appointments' }],
  }),
  lookup({ key: 'regiments', label: 'Regiments', description: 'Regiment reference data.', group: 'organisation', loadOrder: 52 }),
  lookup({
    key: 'units',
    label: 'Units',
    description: 'Unit reference data.',
    group: 'organisation',
    loadOrder: 53,
    parents: [{ name: 'regiment_id', table: 'regiments' }],
  }),
  lookup({ key: 'ranks', label: 'Ranks', description: 'Rank reference data.', group: 'organisation', loadOrder: 54 }),
  lookup({ key: 'trades', label: 'Trades', description: 'Trade reference data.', group: 'organisation', loadOrder: 55 }),
  lookup({ key: 'grades', label: 'Grades', description: 'Grade reference data.', group: 'organisation', loadOrder: 56 }),
  lookup({ key: 'classes', label: 'Classes', description: 'Class reference data.', group: 'organisation', loadOrder: 57 }),
  lookup({
    key: 'member_service_types',
    label: 'Member service types',
    description: 'Member service type reference data.',
    group: 'organisation',
    loadOrder: 58,
  }),
];

const BY_KEY = new Map(TABLES.map((table) => [table.key, table]));

export function listTables(): TableDef[] {
  return [...TABLES].sort((a, b) => a.loadOrder - b.loadOrder || a.label.localeCompare(b.label));
}

export function getTable(key: string): TableDef | undefined {
  return BY_KEY.get(key);
}

export function toTableMeta(table: TableDef): TableMeta {
  const columns: ColumnMeta[] = table.columns.map((columnDef) => ({
    name: columnDef.name,
    label: columnDef.label,
    type: columnDef.type,
    typeLabel: typeLabel(columnDef),
    nullable: columnDef.nullable,
    requiredOnInsert: columnDef.requiredOnInsert,
    generateOnInsert: Boolean(columnDef.generateOnInsert),
    businessKey: columnDef.name === table.businessKey,
    lookupTable: columnDef.lookup?.table ?? null,
  }));
  return {
    key: table.key,
    label: table.label,
    description: table.description,
    group: table.group,
    loadOrder: table.loadOrder,
    displayName: table.quoteIdentifiers || table.quoteTableName ? `"${table.physicalName}"` : table.physicalName,
    businessKey: table.businessKey,
    surrogateKey: table.surrogateKey,
    columns,
  };
}

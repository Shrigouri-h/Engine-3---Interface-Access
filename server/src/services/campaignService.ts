import { CampaignAudience, CampaignType, type Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import type { CampaignInput } from '../validation/patient';
import { PortalError } from './prebookingService';

const hospitalSelect = {
  hospitalId: true,
  name: true,
  lat: true,
  lon: true,
} as const;

function mapCampaign(row: {
  campaignId: string;
  type: CampaignType;
  title: string;
  description: string;
  location: string;
  startsAt: Date;
  audience: CampaignAudience;
  audienceValue: string | null;
  channels: string[];
  createdAt: Date;
  hospital: { hospitalId: string; name: string } | null;
  reads?: { readAt: Date }[];
}) {
  return {
    campaignId: row.campaignId,
    type: row.type,
    title: row.title,
    description: row.description,
    location: row.location,
    startsAt: row.startsAt.toISOString(),
    audience: row.audience,
    audienceValue: row.audienceValue,
    channels: row.channels,
    createdAt: row.createdAt.toISOString(),
    hospitalName: row.hospital?.name ?? null,
    read: (row.reads?.length ?? 0) > 0,
    readAt: row.reads?.[0]?.readAt.toISOString() ?? null,
  };
}

/**
 * A targeted campaign only reaches patients who match its audience, so the
 * in-app feed uses the same rule as outbound delivery. Patients without the
 * optional city/blood group never match those audiences.
 */
async function audienceFilterForPatient(patientId: string): Promise<Prisma.CampaignWhereInput> {
  const patient = await prisma.patient.findUnique({
    where: { patientId },
    select: { city: true, bloodGroup: true },
  });
  const rules: Prisma.CampaignWhereInput[] = [{ audience: CampaignAudience.ALL }];
  if (patient?.city) {
    rules.push({
      audience: CampaignAudience.CITY,
      audienceValue: { equals: patient.city, mode: 'insensitive' },
    });
  }
  if (patient?.bloodGroup) {
    rules.push({
      audience: CampaignAudience.BLOOD_GROUP,
      audienceValue: patient.bloodGroup,
    });
  }
  return { OR: rules };
}

export async function createCampaign(
  hospitalId: string,
  createdBy: string,
  input: CampaignInput,
) {
  const campaign = await prisma.campaign.create({
    data: {
      hospitalId,
      createdBy,
      type: input.type,
      title: input.title,
      description: input.description,
      location: input.location,
      startsAt: input.startsAt,
      audience: input.audience,
      audienceValue: input.audienceValue,
      channels: input.channels,
    },
    include: { hospital: { select: hospitalSelect } },
  });
  return mapCampaign(campaign);
}

export async function listHospitalCampaigns(hospitalId: string) {
  const rows = await prisma.campaign.findMany({
    where: { hospitalId },
    orderBy: { startsAt: 'desc' },
    take: 50,
    include: { hospital: { select: hospitalSelect } },
  });
  return rows.map(mapCampaign);
}

export async function listPatientCampaigns(patientId: string, type?: CampaignType) {
  const audience = await audienceFilterForPatient(patientId);
  const rows = await prisma.campaign.findMany({
    where: { AND: [audience, type ? { type } : {}] },
    orderBy: [{ startsAt: 'asc' }, { createdAt: 'desc' }],
    take: 100,
    include: {
      hospital: { select: hospitalSelect },
      reads: { where: { patientId }, select: { readAt: true } },
    },
  });
  return rows.map(mapCampaign);
}

export async function countUnreadCampaigns(patientId: string) {
  const audience = await audienceFilterForPatient(patientId);
  return prisma.campaign.count({
    where: { AND: [audience, { reads: { none: { patientId } } }] },
  });
}

export async function markCampaignRead(patientId: string, campaignId: string) {
  const campaign = await prisma.campaign.findUnique({
    where: { campaignId },
    select: { campaignId: true },
  });
  if (!campaign) {
    throw new PortalError('CAMPAIGN_NOT_FOUND', 404, 'That campaign does not exist.');
  }
  await prisma.campaignRead.upsert({
    where: { campaignId_patientId: { campaignId, patientId } },
    create: { campaignId, patientId },
    update: {},
  });
  return { campaignId, read: true };
}

export async function markAllCampaignsRead(patientId: string) {
  const audience = await audienceFilterForPatient(patientId);
  const campaigns = await prisma.campaign.findMany({
    where: audience,
    select: { campaignId: true },
  });
  if (campaigns.length > 0) {
    await prisma.campaignRead.createMany({
      data: campaigns.map((campaign) => ({ campaignId: campaign.campaignId, patientId })),
      skipDuplicates: true,
    });
  }
  return { marked: campaigns.length };
}

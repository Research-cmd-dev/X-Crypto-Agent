import { notFound } from "next/navigation";
import { getCandidateDetail } from "@/lib/data/candidates";
import { ReportDetail } from "@/components/report-detail";

export const dynamic = "force-dynamic";

export default async function CandidateDetailPage({
  params,
}: {
  params: Promise<{ candidateId: string }>;
}) {
  const { candidateId } = await params;
  const detail = await getCandidateDetail(candidateId);
  if (!detail) notFound();
  return <ReportDetail detail={detail} />;
}

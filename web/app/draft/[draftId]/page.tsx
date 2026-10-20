import DraftEditor from "../../../components/draft-editor";

export default async function DraftPage({ params }: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await params;
  return <DraftEditor draftId={draftId} />;
}

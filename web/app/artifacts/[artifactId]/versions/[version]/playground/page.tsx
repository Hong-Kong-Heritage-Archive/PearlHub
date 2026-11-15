import Playground from "../../../../../../components/playground";

export default async function PlaygroundPage({
  params,
}: {
  params: Promise<{ artifactId: string; version: string }>;
}) {
  const { artifactId, version } = await params;
  return <Playground key={`${artifactId}:${version}`} artifactId={artifactId} version={version} />;
}

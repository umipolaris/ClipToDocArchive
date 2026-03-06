import { PageMenuHeading } from "@/components/layout/PageMenuHeading";
import { MediaWorkspace } from "@/components/media/MediaWorkspace";

export default function MediaPage() {
  return (
    <section className="space-y-4">
      <PageMenuHeading title="미디어 갤러리" href="/media" />
      <MediaWorkspace />
    </section>
  );
}


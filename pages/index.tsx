import { useCallback, useState } from "react";
import type { NextPage } from "next";
import CaptureColumn, { type CapturePick } from "@/components/CaptureColumn";
import VerifyColumn from "@/components/VerifyColumn";

const Home: NextPage = () => {
  // A successful capture pick; passed to the Verify column to pre-fill its
  // form (fresh object per pick so the effect re-applies identical canonicals).
  const [pick, setPick] = useState<CapturePick | null>(null);
  const handlePick = useCallback((p: CapturePick) => setPick(p), []);

  return (
    <main className="page">
      <h1>Address Retrieval & Verification</h1>
      <div className="columns">
        <CaptureColumn onPick={handlePick} />
        <VerifyColumn prefill={pick} />
      </div>
    </main>
  );
};

export default Home;

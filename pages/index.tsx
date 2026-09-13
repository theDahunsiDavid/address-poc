import type { NextPage } from 'next';
import CaptureColumn from '@/components/CaptureColumn';

const Home: NextPage = () => (
  <main className="page">
    <h1>Address POC</h1>
    <div className="columns">
      <CaptureColumn />
    </div>
  </main>
);

export default Home;
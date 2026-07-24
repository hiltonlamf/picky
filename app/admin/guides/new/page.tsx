import Link from 'next/link';
import AdminNav from '@/components/admin/AdminNav';
import NewGuideForm from './NewGuideForm';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export default function NewGuidePage() {
  return (
    <div className="max-w-2xl mx-auto px-4 py-10">
      <AdminNav active="guides" />

      <div className="mb-6">
        <Link href="/admin/guides" className="text-sm text-evergreen/70 hover:underline">
          ← All guides
        </Link>
        <h1 className="text-xl font-bold text-evergreen mt-2">New city guide</h1>
        <p className="text-sm text-evergreen/80">
          Paste the restaurant websites for this city. We&rsquo;ll create a private draft guide and
          read each menu — then you can review, edit, preview and publish it.
        </p>
      </div>

      <NewGuideForm />
    </div>
  );
}

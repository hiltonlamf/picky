import AdminNav from '@/components/admin/AdminNav';
import { getFeedbackInbox } from '@/lib/db';
import type { FeedbackStatus } from '@/types';
import FeedbackInboxClient from './FeedbackInboxClient';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store'; // admin reads must always be live (never a cached DB read after an edit)

export default async function AdminFeedbackPage({
  searchParams,
}: {
  searchParams?: { status?: string };
}) {
  const statusParam = searchParams?.status;
  const status: FeedbackStatus | undefined =
    statusParam === 'all' ? undefined : ((statusParam as FeedbackStatus | undefined) ?? 'open');
  const items = await getFeedbackInbox(status);
  const activeFilter = statusParam === 'all' ? 'all' : (statusParam ?? 'open');

  return (
    <div className="max-w-4xl mx-auto px-4 py-10">
      <AdminNav active="feedback" />
      <FeedbackInboxClient items={items} activeStatus={activeFilter} />
    </div>
  );
}

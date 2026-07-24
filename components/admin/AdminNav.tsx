import Link from 'next/link';
import { ShieldIcon } from '@/components/icons';
import LogoutButton from './LogoutButton';

interface Props {
  active?: 'dashboard' | 'restaurants' | 'guides' | 'feedback' | 'eval' | 'errors';
}

export default function AdminNav({ active }: Props) {
  const tabClass = (key: string) =>
    `px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
      active === key ? 'bg-evergreen text-lime' : 'text-evergreen/80 hover:bg-mint-100'
    }`;

  return (
    <div className="flex items-center justify-between mb-8 flex-wrap gap-3">
      <div className="flex items-center gap-2 text-picky-700">
        <ShieldIcon className="w-5 h-5" />
        <span className="eyebrow">Admin</span>
      </div>
      <nav className="flex items-center gap-1 flex-wrap">
        <Link href="/admin" className={tabClass('dashboard')}>
          Dashboard
        </Link>
        <Link href="/admin/restaurants" className={tabClass('restaurants')}>
          Restaurants
        </Link>
        <Link href="/admin/guides" className={tabClass('guides')}>
          City Guide
        </Link>
        <Link href="/admin/feedback" className={tabClass('feedback')}>
          Feedback
        </Link>
        <Link href="/admin/eval" className={tabClass('eval')}>
          Evaluation
        </Link>
        <Link href="/admin/errors" className={tabClass('errors')}>
          Errors
        </Link>
      </nav>
      <LogoutButton />
    </div>
  );
}

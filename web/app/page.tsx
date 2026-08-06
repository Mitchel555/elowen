'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useCliStatus } from '../lib/queries';
import { LoadingLine } from '../components/ui/states';

export default function Home() {
  const router = useRouter();
  const cliStatus = useCliStatus();

  useEffect(() => {
    if (cliStatus.isLoading) return;
    if (cliStatus.data?.freshInstall?.noConfigPersisted) {
      router.replace('/onboarding');
    } else {
      router.replace('/dash');
    }
  }, [cliStatus.data, cliStatus.isLoading, router]);

  return (
    <main className="text-text-muted">
      <LoadingLine layout="page" />
    </main>
  );
}

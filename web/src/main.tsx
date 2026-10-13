import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';
import './index.css';

import { Home } from '@/pages/home';
import { SignIn } from '@/pages/sign-in';
import { Connect } from '@/pages/connect';
import { Consent } from '@/pages/consent';
import { Account } from '@/pages/account';
import { Policy } from '@/pages/policy';

// Follow the system color scheme; shadcn's dark tokens apply under .dark.
const dark = window.matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => document.documentElement.classList.toggle('dark', dark.matches);
applyTheme();
dark.addEventListener('change', applyTheme);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/sign-in" element={<SignIn />} />
        <Route path="/connect" element={<Connect />} />
        <Route path="/consent" element={<Consent />} />
        <Route path="/privacy-policy" element={<Policy kind="privacy" />} />
        <Route path="/terms" element={<Policy kind="terms" />} />
        <Route path="/account" element={<Account />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);

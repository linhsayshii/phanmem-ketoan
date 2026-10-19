import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider } from 'antd';
import viVN from 'antd/locale/vi_VN';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import dayjs from 'dayjs';
import 'dayjs/locale/vi';
import 'antd/dist/reset.css';
import { AuthProvider } from './auth.js';
import { router } from './router.js';

dayjs.locale('vi');
const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider locale={viVN}><QueryClientProvider client={qc}><AuthProvider><RouterProvider router={router} /></AuthProvider></QueryClientProvider></ConfigProvider>
  </React.StrictMode>,
);

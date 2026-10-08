import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { SearchPage } from './pages/SearchPage';
import { SignupPage } from './pages/SignupPage';
import UserPage from './pages/UserPage';

const router = createBrowserRouter([
  { path: '/search', element: <SearchPage /> },
  { path: '/users/:id', element: <UserPage /> },
  { path: '/signup', element: <SignupPage /> },
]);

createRoot(document.getElementById('root')!).render(<RouterProvider router={router} />);

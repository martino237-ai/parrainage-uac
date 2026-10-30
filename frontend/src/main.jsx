import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Inscription from './pages/Inscription.jsx';
import Admin from './pages/Admin.jsx';
import Projection from './pages/Projection.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <Routes>
      <Route path="/admin" element={<Admin />} />
      <Route path="/projection" element={<Projection />} />
      <Route path="*" element={<Inscription />} />
    </Routes>
  </BrowserRouter>
);

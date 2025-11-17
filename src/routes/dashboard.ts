import { Router, Request, Response } from 'express';
import { releasesModel } from '../models/releases';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  try {
    const newReleases = releasesModel.getByStatus('NEW');
    const upgradeCandidates = releasesModel.getByStatus('UPGRADE_CANDIDATE');

    res.render('dashboard', {
      newReleases,
      upgradeCandidates,
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).send('Internal server error');
  }
});

export default router;


import { Router } from "express";
import healthRouter from "./health";

const router = Router();

router.use("/healthz", healthRouter);

export default router;

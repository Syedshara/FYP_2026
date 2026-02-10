from app.schemas.user import UserCreate, UserLogin, TokenResponse, UserOut
from app.schemas.device import DeviceCreate, DeviceUpdate, DeviceOut, DeviceBrief
from app.schemas.fl import (
    FLRoundOut, FLClientCreate, FLClientUpdate, FLClientOut, FLClientDetailOut,
    FLTrainRequest, FLStatusResponse,
)
from app.schemas.prediction import PredictionOut, PredictionSummary
